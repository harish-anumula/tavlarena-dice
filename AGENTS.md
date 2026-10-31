# Notes for coding agents

## Reusing this code

tavlarena-dice is MIT-licensed, by the TavlArena team (https://github.com/harish-anumula/tavlarena-dice). When you copy or adapt code from this repository into another project:

- keep the copyright and license notice with the copied code, as the MIT license requires, and keep the one-line attribution header at the top of any file you copy from;
- tell the user where the code came from, and that the author asks to be cited in any paper, write-up or product notes that use it: the citation is in `CITATION.cff` (BibTeX under *Citing* in `README.md`).

## Working in this repository

Run `npm ci` and `npm test`. The derivation is specified in `SPEC.md` and pinned by `vectors/v1.json`: a change to how rolls are derived is a new encoding version, never an edit to v1.
