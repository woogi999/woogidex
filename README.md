<img width="1019" height="343" alt="woogidex_icon" src="https://github.com/user-attachments/assets/babf850a-8043-41d5-aece-380676c3a56e" />

A browser-based toolkit for making, sharing, and battling with Fakemon.

I started this because I wanted one place to actually **design a Fakemon from start to finish**, instead of bouncing between a bunch of different tools. It's grown a fair bit since then.

## What is Woogidex?

Woogidex is a Fakemon editor, Pokédex builder, and community hub.

You make a Pokémon: stats, typing, abilities, moves, Dex entries, artwork, the works. It gets turned into a Pokédex-style board you can export or share. From there you can publish it to the Community Hub, connect it into an evolution line, or even battle it against someone else's team in real time.

It's primarily something I made to help organize my own Fakemon work and Pokeathlon contest submissions, but it's meant to be a general-purpose tool for anyone making Fakemon.

## Features

**Editor**
- Stats, BST, typing, abilities, egg groups, gender ratios, height and weight
- Learnset editor with move recommendations
- Custom moves, abilities, and items, including a visual (Scratch-style) block editor for writing their actual battle effects
- Evolution lines, with methods and connected learnsets
- Sample competitive set generator
- Type matchup / bulk comparison analysis tab
- Shiny artwork, cries, and art credit
- PNG, plain text, JSON, Pokémon Showdown, and Pokémon Essentials export
- A name generator for when you're stuck

**Community**
- Publish Fakemon (and whole evolution families) to a public Community Hub
- Likes, comments, and view counts
- Public profiles with their own comment wall
- Events and contests, with staff-run voting
- A moderation system: banned-word filtering, warnings, mutes, and staff tools

**Battle**
- A real Pokémon-style battle simulator, including a fair amount of Showdown's move/ability/item data
- Battle a bot, or battle another player live over the Community Hub's lobby

**Accounts**
- Free account, needed for the Community Hub and battling
- Your Fakemon collection itself stays local to your browser (IndexedDB) either way

## Sample Set Generator

Woogidex looks at a Fakemon's actual data and tries to build a sensible competitive set for it; base stats, typing, abilities, available moves, STAB, coverage, setup, recovery, priority, hazards, and so on, then scores it against roles like Physical Sweeper, Wallbreaker, Bulky Attacker, Support, Pivot, Hazard Setter, and builds a set around whichever fits best.

It's not perfect, but it's a genuinely useful starting point.

## Local-first Collection, Optional Account

Your Fakemon collection lives in your browser via IndexedDB; no account needed just to design and export Fakemon. You can also export as JSON or plain text to back things up or move them elsewhere.

An account is only needed once you want to publish to the Community Hub, comment, or battle other players.

## Status

Still very much a **work in progress**. Things will probably break, things will probably get redesigned, some systems (looking at you, battle sim) are still being actively fought with.

I'm mostly building this because it's fun, but it's up on GitHub in case anyone else finds it useful or wants to poke around the code.

## Contributing

Found something broken, or have an idea? Open an issue or a PR.

Have fun making weird Pokémon. :3
