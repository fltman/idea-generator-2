// Refuse to start on an older Node with a message that says what to do. The
// "engines" field in package.json is advice to npm, not a check. An older Node
// fails on the .ts entry itself, with an error about the file extension, before
// any of our code runs, so `npm start` and `npm run dev` run this file first as
// its own command (`node server/require-node-25.js && node ... server/index.ts`).
// Not `--import`: Node before 18.18 and 20.0 rejects that flag ("bad option")
// before loading anything. index.ts imports it too, for a direct `node index.ts`.
//
// Keep this file loadable by any Node: a plain script, no import or export (it
// must also parse as CommonJS, which is how Node before 12 reads every .js file),
// and no syntax newer than ES2015 (no ?. or ??, which Node before 14 rejects).
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
