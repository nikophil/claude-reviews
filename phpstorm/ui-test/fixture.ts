// Prints the path of a repository whose a.php changes in the working tree, for a UI test of the PhpStorm plugin.
import { repo, write } from '../../server/fixture.ts';

const dir = repo({ 'a.php': '<?php\n\necho 1;\necho 2;\n' });
write(dir, { 'a.php': '<?php\n\necho 1;\necho 3;\n' });
console.log(dir);
