# Un serveur et un token par compte, pour une machine partagée

claude-reviews était pensé pour un portable mono-utilisateur, sans authentification.
Sur un serveur Linux partagé par plusieurs devs en SSH, chacun avec sa Claude Code, le port fixe `7778` sur `127.0.0.1` est commun à tous les comptes :
la loopback n'est pas cloisonnée par compte, et un seul serveur peut lier le port.
Le premier serveur lancé servait alors tous les autres comptes, git tournait sous son compte dans le worktree d'un autre, `/api/me` donnait son login github.com, et tout process local pouvait lire un dépôt, injecter un message dans la Claude d'un autre, ou arrêter le serveur.

Chaque compte a désormais son serveur, sur un port éphémère, avec un token tiré au démarrage.
Le serveur écrit `{ port, token }` dans `<données>/endpoint` (0600), que le mod, PhpStorm et VS Code lisent ;
l'UI reçoit le token par le fragment `#token=` à l'ouverture, le garde dans `localStorage`, et l'envoie en `Authorization: Bearer` sur chaque appel.
Toute route `/api/` sauf `GET /api/health` exige le token : un autre compte atteint le port, mais n'obtient rien sans lui.
Le dossier de données passe en `0700`, ses fichiers en `0600`.

## Considered Options

- **Un socket Unix dans `$XDG_RUNTIME_DIR`** : cloisonné par l'OS, sans token à gérer.
  Écarté : l'UI est un navigateur, et aucun navigateur ne parle à un socket Unix, même en local ; le serveur doit rester en TCP.
- **Un port dérivé de l'UID** : le verrou `EADDRINUSE` devient gratuit, et le port est connu sans fichier.
  Écarté au profit du port éphémère : collision modulo possible, et échec si le port est déjà pris.
- **Le token inliné dans la page HTML** : plus simple pour l'UI.
  Écarté : un autre compte peut charger `/` et récupérer le token ; il ne doit sortir du serveur que sur preuve de sa possession, d'où le bootstrap par fragment `#token=`.
- **Un cookie posé au bootstrap** : l'UI n'aurait rien à envoyer.
  Écarté au profit de l'en-tête `Authorization` : un en-tête explicite évite l'auto-envoi du cookie et l'ambiguïté CSRF, et unifie l'UI avec le mod, PhpStorm et VS Code.

## Unicité du serveur par compte

Le port éphémère perd le verrou naturel d'`EADDRINUSE` : deux Claude sessions d'un compte pourraient lancer deux serveurs sur les mêmes fichiers.
Au démarrage, le serveur lit l'`endpoint` et renonce si le serveur qu'il nomme, de son compte, répond encore.
Une course subsiste si deux `listen()` démarrent dans le même instant ;
l'écriture atomique des sessions en fait une perte de mise à jour rare, pas une corruption, et un verrou `O_EXCL` la fermerait si elle gênait.

## Un port qui n'est plus à moi

L'`endpoint` survit au serveur : après un reboot ou un crash, il nomme encore son ancien port.
Or `/proc/net/tcp` dit à tout compte quel uid écoute sur quel port ;
un autre compte peut donc lier ce port dès qu'il se libère, et répondre comme claude-reviews.
Sans parade, mon serveur lui laissait la place, et mon mod lui demandait ses threads, puis réveillait ma Claude avec ses consignes.
Le serveur, le mod, PhpStorm et VS Code ne font donc confiance au port de l'`endpoint` que si le socket qui l'écoute est de leur compte, dans `/proc/net/tcp` et `/proc/net/tcp6`.
Le token ne suffit pas à authentifier le serveur : un client l'envoie au premier appel, à quiconque écoute.
Sans `/proc` (macOS), la machine n'a qu'un compte, et les clients font confiance.

## Le token hors de l'argv

Un argv se lit par `/proc/<pid>/cmdline` et `ps`, pour tout compte.
Dans une session SSH, `/review-local` ne lance donc pas de navigateur, qui ne tournerait pas sur le serveur de toute façon, et affiche seulement l'URL avec son fragment.
Le terminal et le transcript restent ceux du compte, qui lit déjà le token dans l'`endpoint`.
Un code d'ouverture à usage unique a été écarté : sur un serveur sans navigateur, personne ne le consomme, et qui l'a lu dans l'argv l'échange avant son expiration.

## La mise à jour

Un serveur d'avant le token (0.6 et avant) reste sur 7778 après la mise à jour, et sert le dossier de données à tout compte.
Au démarrage, le serveur l'arrête s'il est de son compte : il se reconnaît à son 404, au lieu d'un 401, pour une session inconnue sans token.
