# claude-reviews

Relecture locale, façon GitHub, du code que Claude Code écrit dans un worktree,
avec des fils de discussion sous les lignes du diff où Claude répond.

## Language

### Sessions et reviews

**Session**:
La relecture d'un worktree (repo et branche) comparé à sa base, de son ouverture à son approbation.
_Avoid_: review (dans ce sens), PR

**Review**:
Un envoi des messages Pending d'une session : Send, ou Approve.
_Avoid_: round, tour, submission

**Send**:
La review qui livre à Claude les messages Pending et réveille sa Claude session.
_Avoid_: Comment, Request changes

**Approve**:
La review qui clôt une session, alors en lecture seule ; elle n'envoie rien à Claude.

**Base**:
Ce à quoi une session compare le working tree, choisi dans l'UI :
les changements non commités (HEAD), l'état à ma dernière review, ou une branche.
Le diff va toujours jusqu'au working tree, changements non commités compris.
_Avoid_: vues par tour

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
_Avoid_: comment, reply

**Pending**:
Se dit d'un message que j'ai écrit mais pas encore envoyé ; la prochaine review le publie.
_Avoid_: draft, brouillon

**Waiting for Claude**:
Un thread dont le dernier message envoyé est le mien.
_Avoid_: unread, watermark

**Awaiting you**:
Un thread dont le dernier message est de Claude.

**Resolved**:
Un thread que j'ai clos ; seul moi le résous, et un nouveau message le rouvre.

**Outdated**:
Un thread dont la ligne d'ancrage ne se retrouve plus dans le code actuel.
