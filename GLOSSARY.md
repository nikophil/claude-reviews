# claude-reviews

Relecture locale, façon GitHub, du code que Claude Code écrit dans un worktree,
avec des fils de discussion sous les lignes du diff où Claude répond.

## Language

### Sessions et reviews

**Session**:
La relecture d'un worktree comparé à sa base, de son ouverture à son approbation, ou à la disparition du worktree.
Elle suit le worktree, pas la branche : un checkout ou un rebase ne la clôt pas.
Une session close reste consultable, en lecture seule.
_Avoid_: review (dans ce sens), PR

**Review**:
Un envoi des messages Pending d'une session : Send, ou Approve.
_Avoid_: round, tour, submission

**Send**:
La review qui livre à Claude les messages Pending et réveille sa Claude session.
Elle peut n'en porter aucun : elle prend alors un Snapshot, et ne réveille Claude que si des threads l'attendent encore.
_Avoid_: Comment, Request changes

**Approve**:
La review qui clôt une session, alors en lecture seule ; elle n'envoie rien à Claude.

**Base**:
Ce à quoi une session compare le working tree, choisi dans l'UI :
les changements non commités (HEAD), le Snapshot de mon dernier Send, ou une branche.
Le diff va toujours jusqu'au working tree, changements non commités compris.
_Avoid_: vues par tour

**Snapshot**:
Le code que j'avais sous les yeux au moment d'un Send, gardé comme base Since my last review.
_Avoid_: photo, état de la review

**Viewed**:
Se dit d'un fichier du diff que j'ai marqué vu ; son diff se replie.
Il le reste tant que son contenu, dans le code affiché, garde celui que j'ai vu, même si la base change.
_Avoid_: lu, relu

**Claude session**:
Une conversation Claude Code qui tourne dans un worktree.
_Avoid_: session (seul, qui désigne la Session de relecture)

### Fils

**Thread**:
Une discussion entre moi et Claude, ancrée sur une ligne du diff d'une session.
_Avoid_: fil (en code et dans l'UI), annotation, commentaire (pour le fil entier)

**Anchor**:
L'endroit d'un thread : un fichier, un côté du diff (ancien ou nouveau), une plage de lignes et leur contenu.

**Message**:
Une prise de parole dans un thread, de moi ou de Claude.
Un message de Claude est publié dès qu'il l'écrit, hors de toute review ; seuls les miens passent par une review.
_Avoid_: comment, reply

**Pending**:
Se dit d'un message que j'ai écrit mais pas encore envoyé ; la prochaine review le publie.
_Avoid_: draft, brouillon

**Waiting for Claude**:
Un thread non Resolved dont le dernier message envoyé est le mien.
_Avoid_: unread, watermark

**Awaiting you**:
Un thread dont le dernier message est de Claude.

**Resolved**:
Un thread que j'ai clos ; seul moi le résous, et seul un message que j'y écris le rouvre.
Il n'attend plus Claude, même si mon message est le dernier, et une réponse de Claude ne le rouvre pas.

**Outdated**:
Un thread dont la ligne d'ancrage ne se retrouve plus dans le code qu'on regarde : le code affiché pour moi, le working tree pour Claude.
