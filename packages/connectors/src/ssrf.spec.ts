import {
  SsrfError,
  assertPublicHost,
  isBlockedAddress,
  parseAllowList,
  type SsrfErrorCode,
} from './ssrf';

// Aucun accès réseau réel : chaque test injecte son résolveur.
const resolverOf =
  (table: Record<string, string[]>) =>
  async (host: string): Promise<string[]> => {
    if (!Object.hasOwn(table, host)) throw new Error(`ENOTFOUND ${host}`);
    return table[host] as string[];
  };
const noDns = async (host: string): Promise<string[]> => {
  throw new Error(`le DNS ne devait pas être interrogé pour ${host}`);
};

async function rejectCode(p: Promise<unknown>, code: SsrfErrorCode): Promise<SsrfError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SsrfError);
    expect((e as SsrfError).code).toBe(code);
    return e as SsrfError;
  }
  throw new Error('aucune erreur levée');
}

describe('isBlockedAddress', () => {
  it.each([
    // IPv4 internes / réservées
    '0.0.0.0',
    '0.255.255.255',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    // IPv6
    '::',
    '::1',
    '[::1]',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'febf::1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '100::1',
    '2001::1', // Teredo
    '3fff::1',
    // IPv6 transportant une IPv4 bloquée
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.1.2.3',
    '::ffff:a9fe:a9fe', // 169.254.169.254
    '::ffff:0:7f00:1', // IPv4-traduite
    '64:ff9b::127.0.0.1',
    '64:ff9b::a00:1', // NAT64 → 10.0.0.1
    '2002:7f00:1::', // 6to4 → 127.0.0.1
    '2002:c0a8:101::1', // 6to4 → 192.168.1.1
    '::127.0.0.1', // IPv4-compatible (obsolète)
    '64:ff9b:1::1',
    // Non analysable → bloqué (fail-closed)
    '',
    'localhost',
    '2130706433',
    '0x7f000001',
    '0177.0.0.1',
    '127.1',
    '127.000.000.001',
    '01.2.3.4',
    '256.1.1.1',
    '1.2.3',
    'fe80::1%eth0',
    '2606:4700::1111%1',
    '1::2::3',
    '1:2:3:4:5:6:7:8:9',
    'gggg::1',
    '::ffff:127.0.0.01',
  ])('bloque %p', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '100.63.255.255', // juste sous le CGNAT
    '100.128.0.0', // juste au-dessus
    '172.15.255.255',
    '172.32.0.0',
    '192.169.0.1',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '2a00:1450:4007:80b::200e',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '64:ff9b::8.8.8.8',
    '2002:808:808::1', // 6to4 → 8.8.8.8
    '[2606:4700:4700::1111]',
  ])('autorise %p', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('entrée non chaîne → bloquée', () => {
    expect(isBlockedAddress(undefined as unknown as string)).toBe(true);
    expect(isBlockedAddress(2130706433 as unknown as string)).toBe(true);
  });
});

describe('assertPublicHost — hôtes mal formés', () => {
  it.each([
    ['', 'vide'],
    ['a'.repeat(256), 'trop long'],
    ['imap.example.com ', 'espace'],
    [' imap.example.com', 'espace'],
    ['imap example.com', 'espace'],
    ['imap.exämple.com', 'non ASCII'],
    ['１２７.０.０.１', 'chiffres pleine chasse'],
    ['127。0。0。1', 'points idéographiques'],
    ['imap.example.com\n', 'contrôle'],
    ['user@imap.example.com', 'identifiants'],
    ['user:pass@imap.example.com', 'identifiants'],
    ['imaps://imap.example.com', 'schéma'],
    ['imap.example.com/inbox', 'chemin'],
    ['imap.example.com\\x', 'antislash'],
    ['imap.example.com?x=1', 'requête'],
    ['imap.example.com#x', 'fragment'],
    ['imap.example.com:993', 'port'],
    ['[::1]:993', 'port IPv6'],
    ['[2606:4700:4700::1111', 'crochet non fermé'],
    ['imap..example.com', 'label vide'],
    ['.example.com', 'label vide'],
    [`${'a'.repeat(64)}.example.com`, 'label trop long'],
    ['imap.exa*mple.com', 'caractère interdit'],
    ['foo.123', 'dernier label numérique non IPv4'],
    ['1.2.3.4.5', 'trop de parties'],
    ['256.1.1.1', 'octet hors bornes'],
    ['08.1.1.1', 'octal invalide'],
    ['1.2.3.0x', '« 0x » seul : vaut 0 selon WHATWG, notation non standard'],
  ])('refuse %p (%s)', async (host, label) => {
    if (host === '1.2.3.0x') {
      // `0x` seul vaut 0 selon WHATWG : 1.2.3.0 est public, mais la notation n'est pas standard.
      await rejectCode(
        assertPublicHost(host, { resolve: noDns, allowInternal: [] }),
        'non_standard_ip',
      );
      return;
    }
    const err = await rejectCode(
      assertPublicHost(host, { resolve: noDns, allowInternal: [] }),
      'invalid_host',
    );
    expect(err.message.length).toBeGreaterThan(0);
    void label;
  });

  it('entrée non chaîne → refus', async () => {
    await rejectCode(
      assertPublicHost(undefined as unknown as string, { resolve: noDns }),
      'invalid_host',
    );
  });
});

describe('assertPublicHost — noms internes', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'localhost.',
    'api.localhost',
    'imap.local',
    'metadata.google.internal',
    'srv.localdomain',
    'nas.home.arpa',
    'mail.lan',
    'redis', // nom court : service Docker Compose voisin
    'postgres',
  ])('refuse %p sans interroger le DNS', async (host) => {
    const err = await rejectCode(
      assertPublicHost(host, { resolve: noDns, allowInternal: [] }),
      'blocked_name',
    );
    expect(err.message).toMatch(/GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS/);
  });

  it('un nom qui ressemble seulement à un suffixe interne n’est pas bloqué par le nom', async () => {
    const resolve = resolverOf({
      'notlocal.example.com': ['93.184.216.34'],
      'mylocal.com': ['93.184.216.34'],
    });
    await expect(
      assertPublicHost('notlocal.example.com', { resolve, allowInternal: [] }),
    ).resolves.toEqual(['93.184.216.34']);
    await expect(assertPublicHost('mylocal.com', { resolve, allowInternal: [] })).resolves.toEqual([
      '93.184.216.34',
    ]);
  });
});

describe('assertPublicHost — IP littérales et notations alternatives', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '169.254.169.254',
    '0.0.0.0',
    '0',
    '2130706433', // 127.0.0.1 en entier décimal
    '0x7f000001', // hexadécimal
    '0x7F.0.0.1',
    '0x7f.0x0.0x0.0x1',
    '0177.0.0.1', // octal
    '0177.1',
    '127.1', // forme courte
    '127.0.1',
    '3232235777', // 192.168.1.1
    '0xa9fea9fe', // 169.254.169.254
    '017700000001', // 127.0.0.1 en octal entier
    '127.0.0.1.', // point final
    '[::1]',
    '::1',
    '[::]',
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]',
    '[0:0:0:0:0:ffff:7f00:1]',
    '[fe80::1%eth0]',
    'fe80::1%25eth0',
    '[fd00:ec2::254]',
    '[64:ff9b::a9fe:a9fe]',
    '[2002:a9fe:a9fe::]',
  ])('refuse %p', async (host) => {
    const err = await rejectCode(
      assertPublicHost(host, { resolve: noDns, allowInternal: [] }),
      'blocked_address',
    );
    // Jamais l'adresse décodée dans le message.
    expect(err.message).not.toMatch(/127\.0\.0\.1|169\.254|192\.168/);
  });

  it.each([
    ['0x08080808', '8.8.8.8 en hexadécimal'],
    ['134744072', '8.8.8.8 en décimal'],
    ['8.8.2056', '8.8.8.8 forme courte'],
    ['010.010.010.010', '8.8.8.8 en octal'],
  ])('refuse %p (%s) : notation non standard, même publique', async (host) => {
    await rejectCode(
      assertPublicHost(host, { resolve: noDns, allowInternal: [] }),
      'non_standard_ip',
    );
  });

  it('IP publiques canoniques acceptées sans DNS', async () => {
    await expect(
      assertPublicHost('8.8.8.8', { resolve: noDns, allowInternal: [] }),
    ).resolves.toEqual(['8.8.8.8']);
    await expect(
      assertPublicHost('93.184.216.34.', { resolve: noDns, allowInternal: [] }),
    ).resolves.toEqual(['93.184.216.34']);
    await expect(
      assertPublicHost('[2606:4700:4700::1111]', { resolve: noDns, allowInternal: [] }),
    ).resolves.toEqual(['2606:4700:4700::1111']);
    await expect(
      assertPublicHost('2606:4700:4700::1111', { resolve: noDns, allowInternal: [] }),
    ).resolves.toEqual(['2606:4700:4700::1111']);
  });

  it('IPv6 publique avec zone → refus (une zone n’a pas de sens pour un serveur distant)', async () => {
    await rejectCode(
      assertPublicHost('[2606:4700:4700::1111%eth0]', { resolve: noDns, allowInternal: [] }),
      'invalid_host',
    );
  });
});

describe('assertPublicHost — résolution DNS', () => {
  it('nom public → adresses résolues renvoyées (dédoublonnées)', async () => {
    const resolve = resolverOf({
      'imap.example.com': ['93.184.216.34', '2606:2800:220:1::248', '93.184.216.34'],
    });
    await expect(
      assertPublicHost('IMAP.Example.com.', { resolve, allowInternal: [] }),
    ).resolves.toEqual(['93.184.216.34', '2606:2800:220:1::248']);
  });

  it('nom → 127.0.0.1 refusé (ex. 127.0.0.1.nip.io)', async () => {
    const resolve = resolverOf({ '127.0.0.1.nip.io': ['127.0.0.1'] });
    // Le dernier label n'est pas numérique : c'est bien un NOM, jugé sur sa résolution.
    await rejectCode(
      assertPublicHost('127.0.0.1.nip.io', { resolve, allowInternal: [] }),
      'blocked_address',
    );
  });

  it('rebinding simulé : [publique, 10.0.0.5] → refusé (une seule adresse interne suffit)', async () => {
    const resolve = resolverOf({ 'evil.example.com': ['93.184.216.34', '10.0.0.5'] });
    const err = await rejectCode(
      assertPublicHost('evil.example.com', { resolve, allowInternal: [] }),
      'blocked_address',
    );
    expect(err.message).not.toContain('10.0.0.5');
  });

  it.each([
    [['::1']],
    [['::ffff:127.0.0.1']],
    [['fd00::1']],
    [['169.254.169.254']],
    [['0.0.0.0']],
    [['pas-une-ip']],
    [['127.1']],
    [[42]],
  ])('résolution vers %p → refus', async (addrs) => {
    const resolve = async (): Promise<string[]> => addrs as string[];
    await rejectCode(
      assertPublicHost('x.example.com', { resolve, allowInternal: [] }),
      'blocked_address',
    );
  });

  it('résolution vide, en échec ou de mauvaise forme → introuvable, sans recopier l’erreur', async () => {
    await rejectCode(
      assertPublicHost('x.example.com', { resolve: async () => [], allowInternal: [] }),
      'unresolved',
    );
    const err = await rejectCode(
      assertPublicHost('x.example.com', {
        resolve: async () => {
          throw new Error('ENOTFOUND via dns-interne.corp 10.9.8.7');
        },
        allowInternal: [],
      }),
      'unresolved',
    );
    expect(err.message).not.toMatch(/10\.9\.8\.7|dns-interne/);
    await rejectCode(
      assertPublicHost('x.example.com', {
        resolve: async () => null as unknown as string[],
        allowInternal: [],
      }),
      'unresolved',
    );
  });

  it('le résolveur reçoit le nom normalisé (minuscules, sans point final)', async () => {
    const resolve = jest.fn(async () => ['8.8.8.8']);
    await assertPublicHost('Mail.Example.COM.', { resolve, allowInternal: [] });
    expect(resolve).toHaveBeenCalledWith('mail.example.com');
  });
});

describe('assertPublicHost — liste blanche de l’exploitant', () => {
  it('liste vide par défaut (variable d’environnement absente)', async () => {
    const before = process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS;
    delete process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS;
    try {
      await rejectCode(assertPublicHost('10.0.0.5', { resolve: noDns }), 'blocked_address');
    } finally {
      if (before !== undefined) process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS = before;
    }
  });

  it('lue depuis GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS à défaut d’option', async () => {
    const before = process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS;
    process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS = ' mail.corp.internal , 10.20.0.0/16 ';
    try {
      const resolve = resolverOf({ 'mail.corp.internal': ['10.20.1.2'] });
      await expect(assertPublicHost('mail.corp.internal', { resolve })).resolves.toEqual([
        '10.20.1.2',
      ]);
      await expect(assertPublicHost('10.20.3.4', { resolve: noDns })).resolves.toEqual([
        '10.20.3.4',
      ]);
      await rejectCode(assertPublicHost('10.21.0.1', { resolve: noDns }), 'blocked_address');
    } finally {
      if (before === undefined) delete process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS;
      else process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS = before;
    }
  });

  it('un nom autorisé l’est exactement : ni ses sous-domaines, ni un nom voisin', async () => {
    const allowInternal = ['mail.corp.internal'];
    const resolve = resolverOf({
      'mail.corp.internal': ['10.0.0.5'],
      'evil.mail.corp.internal': ['10.0.0.5'],
      'other.corp.internal': ['10.0.0.6'],
      'attacker.example.com': ['10.0.0.5'],
    });
    await expect(
      assertPublicHost('MAIL.corp.internal.', { resolve, allowInternal }),
    ).resolves.toEqual(['10.0.0.5']);
    await rejectCode(
      assertPublicHost('evil.mail.corp.internal', { resolve, allowInternal }),
      'blocked_name',
    );
    await rejectCode(
      assertPublicHost('other.corp.internal', { resolve, allowInternal }),
      'blocked_name',
    );
    // Un nom public qui pointe vers la même IP interne n'hérite pas de l'autorisation du NOM.
    await rejectCode(
      assertPublicHost('attacker.example.com', { resolve, allowInternal }),
      'blocked_address',
    );
  });

  it('un nom court autorisé explicitement (service interne) est accepté', async () => {
    const resolve = resolverOf({ imapsrv: ['172.18.0.4'] });
    await expect(
      assertPublicHost('imapsrv', { resolve, allowInternal: ['imapsrv'] }),
    ).resolves.toEqual(['172.18.0.4']);
  });

  it('CIDR IPv4 : autorise les adresses couvertes, pas les autres', async () => {
    const allowInternal = ['10.0.0.0/24'];
    await expect(
      assertPublicHost('10.0.0.200', { resolve: noDns, allowInternal }),
    ).resolves.toEqual(['10.0.0.200']);
    await rejectCode(
      assertPublicHost('10.0.1.1', { resolve: noDns, allowInternal }),
      'blocked_address',
    );
    // Résolution mixte : publique + interne couverte → accepté ; + interne non couverte → refusé.
    const resolve = resolverOf({
      'a.example.com': ['93.184.216.34', '10.0.0.7'],
      'b.example.com': ['10.0.0.7', '10.0.2.7'],
    });
    await expect(assertPublicHost('a.example.com', { resolve, allowInternal })).resolves.toEqual([
      '93.184.216.34',
      '10.0.0.7',
    ]);
    await rejectCode(
      assertPublicHost('b.example.com', { resolve, allowInternal }),
      'blocked_address',
    );
    // L'IPv4-mappée correspondante est couverte aussi.
    await expect(
      assertPublicHost('[::ffff:10.0.0.9]', { resolve: noDns, allowInternal }),
    ).resolves.toEqual(['::ffff:10.0.0.9']);
    // Une IP autorisée ne lève pas le blocage par NOM.
    await rejectCode(
      assertPublicHost('imap.local', { resolve: noDns, allowInternal }),
      'blocked_name',
    );
  });

  it('IP exacte et CIDR IPv6', async () => {
    await expect(
      assertPublicHost('192.168.1.10', { resolve: noDns, allowInternal: ['192.168.1.10'] }),
    ).resolves.toEqual(['192.168.1.10']);
    await rejectCode(
      assertPublicHost('192.168.1.11', { resolve: noDns, allowInternal: ['192.168.1.10'] }),
      'blocked_address',
    );
    await expect(
      assertPublicHost('[fd12::5]', { resolve: noDns, allowInternal: ['fd12::/64'] }),
    ).resolves.toEqual(['fd12::5']);
    await rejectCode(
      assertPublicHost('[fd13::5]', { resolve: noDns, allowInternal: ['fd12::/64'] }),
      'blocked_address',
    );
  });

  it('une notation alternative reste refusée même si l’IP est autorisée', async () => {
    await rejectCode(
      assertPublicHost('0x0a000005', { resolve: noDns, allowInternal: ['10.0.0.5'] }),
      'non_standard_ip',
    );
  });

  it('jamais autorisées : 0.0.0.0, ::, métadonnées cloud, multicast — même listées', async () => {
    const allowInternal = [
      '0.0.0.0/8',
      '169.254.0.0/16',
      '::/16',
      'fd00:ec2::/32',
      '224.0.0.0/8',
      'meta.internal',
    ];
    for (const host of [
      '0.0.0.0',
      '169.254.169.254',
      '[::]',
      '[fd00:ec2::254]',
      '224.0.0.1',
      '[::ffff:169.254.169.254]',
    ]) {
      await rejectCode(
        assertPublicHost(host, { resolve: noDns, allowInternal }),
        'blocked_address',
      );
    }
    const resolve = resolverOf({ 'meta.internal': ['169.254.169.254'] });
    await rejectCode(
      assertPublicHost('meta.internal', { resolve, allowInternal }),
      'blocked_address',
    );
    // 169.254.0.0/16 reste utilisable hors métadonnées si l'exploitant l'a voulu.
    await expect(
      assertPublicHost('169.254.10.10', { resolve: noDns, allowInternal }),
    ).resolves.toEqual(['169.254.10.10']);
  });

  it('entrées invalides ou trop larges ignorées (la liste blanche ne peut que restreindre)', async () => {
    const allowInternal = [
      '0.0.0.0/0',
      '10.0.0.0/7',
      '::/0',
      '2000::/8',
      'not a host',
      '10.0.0.0/33',
      '10.0.0.0/x',
      '*.internal',
      '',
    ];
    for (const host of ['10.0.0.5', '127.0.0.1', '[::1]', '[fd00::1]']) {
      await rejectCode(
        assertPublicHost(host, { resolve: noDns, allowInternal }),
        'blocked_address',
      );
    }
    await rejectCode(
      assertPublicHost('x.internal', { resolve: noDns, allowInternal }),
      'blocked_name',
    );
  });

  it('parseAllowList', () => {
    expect(parseAllowList(undefined)).toEqual([]);
    expect(parseAllowList('')).toEqual([]);
    expect(parseAllowList(' a.b , ,10.0.0.0/8,')).toEqual(['a.b', '10.0.0.0/8']);
  });
});
