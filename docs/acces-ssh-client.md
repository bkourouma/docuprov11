# Accès SSH au serveur — Déploiement de l'application « DocuPro »

Document à remettre à l'**équipe informatique du client**.
Objectif : permettre au prestataire de déployer l'application **DocuPro** sur votre serveur Windows,
à distance et de façon sécurisée, depuis son ordinateur portable **connecté à votre réseau**.

L'accès se fait par **clé SSH** (pas de mot de passe qui circule), il est **traçable** et
**entièrement révocable** une fois le déploiement terminé.

---

## 1. Résumé de ce qui est demandé

| # | Besoin | Pourquoi |
|---|---|---|
| 1 | Brancher le portable du prestataire sur un **point réseau** qui atteint le serveur (port **22**) | Établir la connexion SSH |
| 2 | Un **compte Windows** sur le serveur, avec droits **administrateur** | Installer les services applicatifs |
| 3 | **OpenSSH Server** activé sur le serveur | Connexion à distance |
| 4 | Autoriser la **clé publique** du prestataire (fournie au §4) | Authentification sans mot de passe |
| 5 | **Internet sortant** sur le serveur (ou proxy communiqué) | Télécharger Node, paquets, images Docker |
| 6 | Renvoyer les **informations du §6** | Préparer le déploiement |

> Les droits administrateur ne sont nécessaires **que le temps du déploiement** (installation des
> services Windows). Le compte et la clé peuvent être désactivés/supprimés ensuite (voir §7).

---

## 2. Accès réseau

Le portable du prestataire doit pouvoir **joindre le serveur sur le port TCP 22**.

- Idéalement : un **port réseau filaire** (ou Wi‑Fi non isolé) sur le même VLAN que le serveur,
  ou une règle autorisant ce poste vers le serveur:22.
- À éviter : un Wi‑Fi « invité » isolé qui bloque l'accès aux serveurs internes.

Merci de confirmer avec votre administrateur réseau que ce flux est autorisé.

---

## 3. Activer OpenSSH Server (sur le serveur, PowerShell **administrateur**)

```powershell
# 1) Installer le composant OpenSSH Server (Windows 10/11/Server 2019+)
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# 2) Démarrage automatique + lancer le service
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd

# 3) Règle de pare-feu pour le port 22 (créée d'office en général ; on s'assure qu'elle existe)
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
}

# 4) (Recommandé) Shell par défaut = PowerShell, pour faciliter les commandes de déploiement
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force
```

---

## 4. Compte de déploiement + autorisation de la clé

### 4.1 Créer un compte dédié (recommandé — ou réutiliser un compte admin existant)

```powershell
# Mot de passe demandé de façon masquée
$pw = Read-Host -AsSecureString "Mot de passe du compte de deploiement"
New-LocalUser -Name "deploy-docupro" -Password $pw `
  -FullName "Deploiement DocuPro" -Description "Compte temporaire de deploiement prestataire"
Add-LocalGroupMember -Group "Administrators" -Member "deploy-docupro"
```

### 4.2 Installer la clé publique du prestataire

La clé publique à autoriser (une seule ligne) :

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHIHFhPQe3y2qd+j0OBAEd7YfhfL/i+5uJxrpJe6KUe3 micka-deployer
```

> ⚠️ **Important sous Windows** : pour un compte **membre des administrateurs**, OpenSSH lit la clé
> dans `C:\ProgramData\ssh\administrators_authorized_keys` (et **pas** dans le profil de
> l'utilisateur). Les droits du fichier doivent être restreints, sinon la connexion par clé est
> silencieusement refusée.

**Compte administrateur** (cas du compte `deploy-docupro` ci‑dessus) :

```powershell
$pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHIHFhPQe3y2qd+j0OBAEd7YfhfL/i+5uJxrpJe6KUe3 micka-deployer'
$f = "$env:ProgramData\ssh\administrators_authorized_keys"
Add-Content -Path $f -Value $pub -Encoding ascii
# Droits : uniquement SYSTEM et le groupe Administrateurs
icacls $f /inheritance:r /grant "SYSTEM:F" "BUILTIN\Administrators:F"
```

**Compte standard (non‑administrateur)** — alternative si aucun droit admin n'est accordé
(dans ce cas, l'installation des dépendances/services sera faite par vos soins, cf. §5) :

```powershell
# À exécuter en étant connecté avec CE compte :
$pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHIHFhPQe3y2qd+j0OBAEd7YfhfL/i+5uJxrpJe6KUe3 micka-deployer'
$d = "$env:USERPROFILE\.ssh"; New-Item -ItemType Directory -Force $d | Out-Null
Add-Content -Path "$d\authorized_keys" -Value $pub -Encoding ascii
```

### 4.3 Vérifier

```powershell
Get-Service sshd                 # doit être "Running"
Restart-Service sshd             # à faire après avoir changé le DefaultShell
```

---

## 5. Prérequis applicatifs (à pré‑installer, ou laisser le prestataire les installer)

L'application a besoin des composants suivants. Vous pouvez les **pré‑installer** (idéal), ou nous
laisser le faire via SSH si le compte est administrateur **et** que le serveur a Internet.

| Composant | Version | Remarque |
|---|---|---|
| **Node.js LTS** | ≥ 20 | https://nodejs.org (MSI « LTS ») |
| **Git** | récent | pour récupérer le code (sinon transfert direct par le prestataire) |
| **PostgreSQL** | 16 | base de données ; ou indiquez une instance existante (cf. §6) |
| **Redis** | — | au choix : **Docker Desktop** (image `redis`) **ou** **Memurai** (service Redis natif Windows) |

> **Docker Desktop** peut nécessiter une **licence** selon la taille de l'entreprise, et repose sur
> WSL2 / Hyper‑V. Si vous préférez éviter Docker sur le serveur, **Memurai** (https://www.memurai.com)
> fournit un Redis natif sous forme de service Windows — c'est parfaitement adapté.

---

## 6. Informations à transmettre au prestataire

Merci de nous communiquer (par un canal sûr) :

- [ ] **Adresse IP / nom** du serveur + **version de Windows**
- [ ] **Nom du compte** de déploiement (ex. `deploy-docupro`) + confirmation que **la clé est installée**
- [ ] **Internet sortant** : oui / non — s'il y a un **proxy**, son adresse et port
- [ ] **PostgreSQL** : déjà installé ? → version, hôte/port, et identifiants d'un compte pouvant créer
      la base `DocuPro` ; sinon, on l'installe
- [ ] **Redis** : Docker Desktop disponible ? sinon, **Memurai** est‑il autorisé ?
- [ ] **Chemin d'installation** souhaité pour l'application (ex. `D:\Apps\DocuPro`)
- [ ] **Disque/chemin** pour le coffre de fichiers numérisés (`ARCHIVES`) + espace disponible
      (les binaires y sont stockés ; prévoir de la place)
- [ ] **HTTPS** souhaité ? si oui : **nom de domaine interne** + qui fournit le **certificat TLS**
- [ ] **Emplacement des sauvegardes** (base + coffre `ARCHIVES`)

---

## 7. Sécurité & réversibilité (pour information)

- L'accès se fait **par clé** (algorithme Ed25519), aucun mot de passe partagé.
- Toutes les connexions SSH sont **journalisées** par Windows (journal *OpenSSH/Operational*).
- **Après le déploiement**, vous pouvez révoquer l'accès immédiatement :

```powershell
# Retirer la clé autorisée
Remove-Item "$env:ProgramData\ssh\administrators_authorized_keys" -ErrorAction SilentlyContinue
# Désactiver (ou supprimer) le compte de déploiement
Disable-LocalUser -Name "deploy-docupro"
# Optionnel : arrêter/désactiver le serveur SSH si vous ne l'utilisez pas par ailleurs
Stop-Service sshd; Set-Service sshd -StartupType Disabled
```

- **Alternative à SSH** : si l'accès SSH n'est pas possible dans votre environnement, un accès
  **RDP** (Bureau à distance) avec partage d'écran convient également ; prévenez‑nous.

---

*Document préparé pour le déploiement de DocuPro. Pour toute question technique, contactez le prestataire.*
