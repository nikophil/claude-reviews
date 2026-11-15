// Prints the path of a repository whose a.php changes in the working tree, for a UI test of the PhpStorm plugin.
import { repo, write } from '../../server/fixture.ts';

// PhpStorm writes .idea/ into the repository: ignored, it neither counts as a change nor shifts the rows of the tree.
const dir = repo({ '.gitignore': '.idea/\n', 'a.php': '<?php\n\necho 1;\necho 2;\n' });
write(dir, { 'a.php': '<?php\n\necho 1;\necho 3;\n' });
console.log(dir);
