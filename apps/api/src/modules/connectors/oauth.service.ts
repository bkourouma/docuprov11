import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  assertRedirectUriAllowed,
  buildAuthorizationUrl,
  CredentialsCryptoError,
  decryptCredentials,
  deriveStateKey,
  encryptCredentials,
  exchangeAuthorizationCode,
  generatePkce,
  getProviderConfig,
  loadKeyRing,
  newOAuthNonce,
  OAuthConfigError,
  OAuthFlowError,
  parseRedirectAllowList,
  signOAuthState,
  verifyOAuthState,
  type ConnectorDefinition,
  type ConnectorRegistry,
  type KeyRing,
  type OAuthHttpClient,
} from '@archivage/connectors';
import {
  GedSourceConnectorStatus,
  type GedOAuthCallbackResponse,
  type GedOAuthStartResponse,
} from '@archivage/types';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { GED_CONNECTOR_REGISTRY } from './connectors.service';
import type { OAuthCallbackDto, OAuthStartDto } from './oauth.dto';
import { GED_OAUTH_STATE_STORE, type OAuthStateStore } from './oauth-state.store';

/** Jeton (optionnel) pour injecter environnement, client HTTP et horloge — tests uniquement. */
export const GED_OAUTH_RUNTIME = 'GED_OAUTH_RUNTIME';

export interface OAuthRuntime {
  env?: NodeJS.ProcessEnv;
  http?: OAuthHttpClient;
  now?: () => Date;
}

/** Durée de validité d'une autorisation en cours (state signé ET enregistrement serveur). */
export const OAUTH_STATE_TTL_SECONDS = 600;

const MISSING_KEY_MESSAGE =
  'Clé de chiffrement des connecteurs absente (GED_CONNECTOR_KEY) : autorisation OAuth impossible';
const NO_ALLOW_LIST_MESSAGE =
  'Liste blanche des URI de redirection non configurée (GED_OAUTH_REDIRECT_URIS)';
const INVALID_STATE_MESSAGE = 'Autorisation invalide ou expirée : recommencez';
const REPLAYED_MESSAGE = 'Autorisation déjà utilisée ou expirée : recommencez';
const PROVIDER_REFUSED_MESSAGE = 'Le fournisseur a refusé l’autorisation';

const actorName = (user: AuthUser): string => user.fullName?.trim() || user.username;

/**
 * Autorisation OAuth 2.0 (code + PKCE) d'un connecteur de source GED.
 *
 * Invariants : code, state, vérificateur PKCE, jeton et secret client n'apparaissent ni dans une
 * réponse, ni dans un journal, ni dans l'audit, ni dans un message d'erreur. Le vérificateur n'est
 * stocké que chiffré. L'état est à usage unique et lié à l'administrateur qui l'a demandé.
 */
@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);
  private readonly env: NodeJS.ProcessEnv;
  private readonly http?: OAuthHttpClient;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(GED_CONNECTOR_REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(GED_OAUTH_STATE_STORE) private readonly store: OAuthStateStore,
    @Optional() @Inject(GED_OAUTH_RUNTIME) runtime?: OAuthRuntime,
  ) {
    this.env = runtime?.env ?? process.env;
    this.http = runtime?.http;
    this.now = runtime?.now ?? (() => new Date());
  }

  async start(id: number, dto: OAuthStartDto, user: AuthUser): Promise<GedOAuthStartResponse> {
    const row = await this.getRow(id);
    const oauth = this.oauthOf(row.connectorType);
    const ring = this.requireKeyRing();

    try {
      getProviderConfig(oauth.provider, this.env);
    } catch (e) {
      // Le message d'`OAuthConfigError` ne contient que des NOMS de variables.
      if (e instanceof OAuthConfigError) throw new ConflictException(e.message);
      throw e;
    }

    const allowList = parseRedirectAllowList(this.env.GED_OAUTH_REDIRECT_URIS);
    if (allowList.length === 0) throw new ConflictException(NO_ALLOW_LIST_MESSAGE);
    try {
      assertRedirectUriAllowed(dto.redirectUri, allowList);
    } catch (e) {
      if (e instanceof OAuthFlowError) throw new BadRequestException(e.message);
      throw e;
    }

    const pkce = generatePkce();
    const nonce = newOAuthNonce();
    const exp = Math.floor(this.now().getTime() / 1000) + OAUTH_STATE_TTL_SECONDS;
    const state = signOAuthState(
      { n: nonce, exp, uid: user.userId, cid: id, provider: oauth.provider },
      deriveStateKey(this.env),
    );
    const sealed = encryptCredentials({ verifier: pkce.verifier }, ring);
    await this.store.put(
      nonce,
      {
        uid: user.userId,
        cid: id,
        provider: oauth.provider,
        redirectUri: dto.redirectUri,
        verifierEnc: sealed.credentialsEnc,
        verifierKeyId: sealed.credentialsKeyId,
      },
      OAUTH_STATE_TTL_SECONDS,
    );

    let authorizationUrl: string;
    try {
      authorizationUrl = buildAuthorizationUrl({
        provider: oauth.provider,
        env: this.env,
        scopes: oauth.scopes,
        redirectUri: dto.redirectUri,
        state,
        codeChallenge: pkce.challenge,
      });
    } catch (e) {
      // Rien n'a été présenté à l'utilisateur : l'enregistrement est retiré.
      await this.store.take(nonce);
      if (e instanceof OAuthFlowError) throw new BadRequestException(e.message);
      if (e instanceof OAuthConfigError) throw new ConflictException(e.message);
      throw e;
    }

    await this.auditChange(user, id, 'oauth-start');
    return { authorizationUrl, expiresInSeconds: OAUTH_STATE_TTL_SECONDS };
  }

  async callback(dto: OAuthCallbackDto, user: AuthUser): Promise<GedOAuthCallbackResponse> {
    const ring = this.requireKeyRing();

    let payload;
    try {
      payload = verifyOAuthState(dto.state, deriveStateKey(this.env), this.now());
    } catch (e) {
      if (e instanceof OAuthFlowError) throw new BadRequestException(INVALID_STATE_MESSAGE);
      throw e;
    }

    // AVANT la consommation : un autre administrateur ne doit pas pouvoir « brûler » l'état d'autrui.
    if (payload.uid !== user.userId) {
      throw new ForbiddenException('Autorisation liée à un autre administrateur');
    }

    const record = await this.store.take(payload.n);
    if (!record) throw new BadRequestException(REPLAYED_MESSAGE);
    if (
      record.uid !== payload.uid ||
      record.cid !== payload.cid ||
      record.provider !== payload.provider
    ) {
      throw new BadRequestException(INVALID_STATE_MESSAGE);
    }

    const row = await this.getRow(payload.cid);
    const oauth = this.oauthOf(row.connectorType);
    if (oauth.provider !== payload.provider) {
      throw new BadRequestException(INVALID_STATE_MESSAGE);
    }

    let verifier: string;
    try {
      verifier = decryptCredentials(record.verifierEnc, record.verifierKeyId, ring).verifier ?? '';
    } catch (e) {
      if (e instanceof CredentialsCryptoError) throw new BadRequestException(INVALID_STATE_MESSAGE);
      throw e;
    }

    let token;
    try {
      token = await exchangeAuthorizationCode({
        provider: oauth.provider,
        env: this.env,
        scopes: oauth.scopes,
        redirectUri: record.redirectUri,
        code: dto.code,
        codeVerifier: verifier,
        http: this.http,
        now: this.now,
      });
    } catch (e) {
      if (e instanceof OAuthConfigError) throw new ConflictException(e.message);
      // Ni message ni détail fournisseur : seulement le code d'erreur interne.
      this.logger.warn(
        `Échange OAuth refusé (connecteur ${payload.cid}) : ${
          e instanceof OAuthFlowError ? e.code : 'erreur'
        }`,
      );
      throw new BadRequestException(PROVIDER_REFUSED_MESSAGE);
    }

    const sealed = encryptCredentials(
      token.scope
        ? { refreshToken: token.refreshToken, scope: token.scope }
        : { refreshToken: token.refreshToken },
      ring,
    );
    try {
      await this.prisma.gedSourceConnector.update({
        where: { gedSourceConnectorId: payload.cid },
        data: {
          credentialsEnc: sealed.credentialsEnc,
          credentialsKeyId: sealed.credentialsKeyId,
          credentialsRef: null,
          credentialsExpiresAt: token.refreshTokenExpiresAt ?? null,
          // Un connecteur désactivé le reste : l’autorisation ne le réactive pas.
          status: row.isActive ? GedSourceConnectorStatus.Actif : GedSourceConnectorStatus.Inactif,
          lastError: null,
          // Le compte autorisé a pu changer : relistage complet à la prochaine passe (idempotent).
          changeToken: null,
        },
      });
    } catch (e) {
      if ((e as { code?: string } | null)?.code === 'P2025') {
        throw new NotFoundException('Connecteur introuvable');
      }
      throw e;
    }

    await this.auditChange(user, payload.cid, 'oauth-authorized');
    return {
      connectorId: payload.cid,
      authorized: true,
      expiresAt: token.refreshTokenExpiresAt ? token.refreshTokenExpiresAt.toISOString() : null,
    };
  }

  // -------------------------------------------------------------------------

  private async getRow(id: number) {
    const row = await this.prisma.gedSourceConnector.findUnique({
      where: { gedSourceConnectorId: id },
    });
    if (!row) throw new NotFoundException('Connecteur introuvable');
    return row;
  }

  private oauthOf(type: string): NonNullable<ConnectorDefinition['oauth']> {
    const def = this.registry.get(type);
    if (!def?.oauth) {
      throw new BadRequestException('Ce type de connecteur ne s’autorise pas par OAuth');
    }
    return def.oauth;
  }

  private requireKeyRing(): KeyRing {
    const raw = this.env.GED_CONNECTOR_KEY;
    if (raw == null || raw.trim() === '') {
      throw new ServiceUnavailableException(MISSING_KEY_MESSAGE);
    }
    try {
      return loadKeyRing(this.env);
    } catch (e) {
      if (e instanceof CredentialsCryptoError) throw new ServiceUnavailableException(e.message);
      throw e;
    }
  }

  /** Jamais d'URL, de state, de code ni de jeton dans l'audit : seulement la nature du changement. */
  private async auditChange(user: AuthUser, id: number, newValue: string): Promise<void> {
    await this.audit.dataChange({
      userGroupId: user.userGroupId,
      actorFullName: actorName(user),
      objectRef: `ged_source_connector:${id}`,
      newValue,
    });
  }
}
