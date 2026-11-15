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
Elle peut ne livrer que les messages Pending d'un thread, depuis son bouton Send dans PhpStorm ou VS Code : elle prend quand même son Snapshot, et les autres restent Pending.
_Avoid_: Comment, Request changes

**Approve**:
La review qui clôt une session, alors en lecture seule ; elle n'envoie rien à Claude.

**Base**:
Ce à quoi une session compare le working tree, choisi dans l'UI :
les changements non commités (HEAD), le Snapshot de mon dernier Send, une branche (par défaut, de base, locale ou distante), ou une PR ouverte.
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

**Client**:
Ce qui m'affiche une session et y écrit pour moi : la page dans un navigateur, ou un IDE (PhpStorm, VS Code).
Un client ne parle qu'à l'API HTTP du serveur ; le côté Claude, lui, passe par le mod.
_Avoid_: front, outil

### Fils

**Thread**:
Une discussion entre moi et Claude, ancrée sur des lignes du diff d'une session, ou sur un fichier entier.
_Avoid_: fil (en code et dans l'UI), annotation, commentaire (pour le fil entier)

**Anchor**:
L'endroit d'un thread : un fichier, un côté du diff (ancien ou nouveau), une plage de lignes et leur contenu ; sans plage pour un thread sur le fichier entier.
Pour moi comme pour Claude, le côté ancien est la base de la session, et le nouveau le working tree.

**Message**:
Une prise de parole dans un thread, de moi ou de Claude.
Un message de Claude est publié dès qu'il l'écrit, hors de toute review ; seuls les miens passent par une review.
_Avoid_: comment, reply

**Pending**:
Se dit d'un message que j'ai écrit mais pas encore envoyé ; la prochaine review le publie.
Tant qu'il l'est, je peux le modifier ou le supprimer, et un thread qui n'a plus de message disparaît avec lui.
_Avoid_: draft, brouillon

**Suggestion**:
Un bloc de code d'un de mes messages, qui propose le code à mettre à la place des lignes du thread, côté nouveau.
Claude l'applique au working tree, sauf désaccord, puis répond dans le thread ; aucun client ne l'applique lui-même.
_Avoid_: patch, commit suggestion

**Waiting for Claude**:
Un thread non Resolved dont le dernier message envoyé est le mien.
_Avoid_: unread, watermark

**Replied**:
Se dit d'un thread non Resolved où Claude a écrit depuis mon dernier Send ; avant mon premier Send, aucun ne l'est.
C'est une marque pour retrouver ses réponses, pas un statut du thread.
_Avoid_: Awaiting you, unread

Un thread non Resolved où Claude a parlé en dernier n'a pas de nom ni de statut affiché : la notification « Claude replied in every thread » et le message de Claude suffisent.
_Avoid_: Awaiting you

**Resolved**:
Un thread que j'ai clos ; seul moi le résous, et seul mon Unresolve le rouvre.
Il n'attend plus Claude, même si mon message est le dernier, et une réponse de Claude ne le rouvre pas.
Je n'y écris plus avant son Unresolve, et un Send garde Pending les messages que j'y avais écrits avant de le résoudre ; un Approve les laisse Pending, sans les envoyer.

**Unresolve**:
Rouvrir un thread Resolved : je peux de nouveau y écrire, et le Send suivant publie ses messages Pending.
_Avoid_: reopen, réouverture

**Outdated**:
Un thread dont les lignes d'ancrage ne se retrouvent plus dans le code qu'on regarde : le code affiché pour moi, la base de la session et le working tree pour Claude.
Un thread sur un fichier entier l'est quand son fichier a disparu de ce code.
