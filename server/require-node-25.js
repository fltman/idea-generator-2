// Refuse to start on an older Node with a message that says what to do. The
// "engines" field in package.json is advice to npm, not a check. This file is
// plain JavaScript and is loaded before server/index.ts (first import there,
// and `--import` in `npm start`), because an older Node fails on the .ts entry
// itself, with an error about the file extension, before any of our code runs.
const REQUIRED = 25;
const major = Number(process.versions.node.split('.')[0]);
if (major < REQUIRED) {
  process.stderr.write(
    `Idégeneratorn needs Node ${REQUIRED} or newer: it runs TypeScript directly and uses node:sqlite.\n` +
    `You have Node ${process.versions.node} (${process.execPath}).\n` +
    `Install the current release from https://nodejs.org or switch with your version manager (nvm use 25, fnm use 25).\n`,
  );
  process.exit(1);
}
