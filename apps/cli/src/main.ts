import { program } from './program';

program()
  .parseAsync(process.argv)
  .catch((e: Error) => {
    console.error(`sdlc: ${e.message}`);
    process.exitCode = 1;
  });
