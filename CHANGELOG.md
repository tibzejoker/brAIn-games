# Changelog

## 1.0.0 (2026-05-29)


### Features

* brAIn-games — LLM-driven game nodes (hangman + tictactoe) ([9fe759d](https://github.com/tibzejoker/brAIn-games/commit/9fe759d0cdba08ef6de08473da54aae3b74af65f))
* brainpet — LLM-driven virtual pet with procedural canvas, cemetery, emoji animations ([11a949e](https://github.com/tibzejoker/brAIn-games/commit/11a949e9f07428973ae61c37085253ecff537b2c))
* **llm:** add tool call support and use framework llm use everywhere ([a6fedae](https://github.com/tibzejoker/brAIn-games/commit/a6fedae26c62a00618ccc1b6995efb37db19c3d7))
* **seeds:** ship hangman, tictactoe, and brainpet templates ([b583c3b](https://github.com/tibzejoker/brAIn-games/commit/b583c3b340ff3d08fcafc3bafae0e806981fb0b1))


### Bug Fixes

* **games/ui:** game UI inputs publish straight to the game's command topic ([1e31324](https://github.com/tibzejoker/brAIn-games/commit/1e3132485c7dbdf95a8ee82731e452b756dbaf74))
* **games/ui:** listen to game.*.event for narration — chat.response never arrives ([16dd6c8](https://github.com/tibzejoker/brAIn-games/commit/16dd6c88c488b716257238f2ffef7a9584324ae7))
* **games/ui:** revert direct game.command publish — let the brain route ([3a4e28d](https://github.com/tibzejoker/brAIn-games/commit/3a4e28d7fa869b26d500e680fc752b56ce215b3e))
* **games/ui:** UI guesses/moves never reached the game node — also publish on the command topic ([d08ae17](https://github.com/tibzejoker/brAIn-games/commit/d08ae17075813c85b82d8e8ab0f864925de5bbc3))
* **games:** bump maxTokens on tool-call sites — gemma4 thinking eats the budget ([e351009](https://github.com/tibzejoker/brAIn-games/commit/e35100957f6603cd1b83a9fec9d1d88b5a109361))
* **games:** ctx.llm.tool() returns args directly, not {toolName, args} ([fe981a6](https://github.com/tibzejoker/brAIn-games/commit/fe981a6e4cc124600f559ecab1fc1c2838f33615))
* **games:** permissive tool schemas + code-side validation — gemma4 emits TIGER not tiger ([baaaddb](https://github.com/tibzejoker/brAIn-games/commit/baaaddb902ccfff8a2fd32fa5bf44e88d23faebb))
* migrate game UIs (brainpet, hangman, tictactoe) to /node/:id/:topic ([#13](https://github.com/tibzejoker/brAIn-games/issues/13)) ([acf4031](https://github.com/tibzejoker/brAIn-games/commit/acf4031450ea89c9d97d0a02c9cfe1776c1a4173))
* **seeds:** drop brainpet.state/cemetery from the chat subscriptions ([d52e8ca](https://github.com/tibzejoker/brAIn-games/commit/d52e8ca6fe6aa31a8ad5f1fc4ed99c5520fc33bc))
