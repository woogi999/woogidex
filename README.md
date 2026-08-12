<img width="1019" height="343" alt="woogidex_icon" src="https://github.com/user-attachments/assets/babf850a-8043-41d5-aece-380676c3a56e" />

A little browser-based toolkit for making and organizing Fakemon.

I'm making this because I wanted something where I could actually **design a Fakemon from start to finish** instead of having to bounce between a bunch of different tools.

## What is Woogidex?

Woogidex is a local-first Fakemon editor and Pokédex builder.

You can make a Pokémon, give it stats, abilities, moves, Dex entries, sample competitive sets, etc., and then see everything presented as a little Pokédex-style board.

The tool is basically this: **"What if I had a Pokédex database that was also a Fakemon design tool?"**

It's primarily something I made to help organize my own Fakemon work and **Pokeathlon contest submissions**, but it's meant to be a general-purpose tool for anyone making Fakemon.

## Features

- Fakemon editor
- Pokémon-style stats and BST calculation
- Types, abilities, egg groups, gender ratios, height and weight
- Learnset editor
- Learnset Generator & Recommended Moves
- Pokédex-style visual board
- Sample competitive sets
- STAB / coverage / status move classification
- PNG export
- Plain text export
- JSON export and import
- Local browser storage with IndexedDB
- No account required
- No server required for your Fakemon data

## Sample Set Generator

One of the things I'm working on is a **competitive set generator**.

Woogidex looks at the Fakemon's actual data and tries to figure out what makes sense.

It considers things like:

- Base stats
- Typing
- Abilities
- Available moves
- STAB
- Coverage
- Setup moves
- Recovery
- Status moves
- Priority
- Hazards
- Move synergy
- Potential roles

It can then score possible roles such as:

- Physical Sweeper
- Special Sweeper
- Wallbreaker
- Bulky Attacker
- Defensive
- Support
- Pivot
- Setup Sweeper
- Hazard Setter / Remover

From there it builds a set around the most appropriate role.

It's currently bad right now but hey, it's at least usable!

## Local-first

Your Fakemon are stored locally in your browser using **IndexedDB**.

There's no account system or database server required just to use the editor.

You can also export your Fakemon as **JSON or plain text**, making it easy to back up your work or move it somewhere else.

## Pokédex Board

One of the main parts of Woogidex is the Pokédex-style board.

It takes all the information you've entered and turns it into a more presentable Pokémon card, including things like:

- Pokémon artwork
- Typing
- Stats
- Abilities
- Dex entries
- Important moves
- Competitive information

The board can be exported as a PNG, which makes it useful for sharing submissions or showing off a Fakemon without having to send someone the entire editor.

## Evolution Support

Evolution lines aren't implemented yet, but they're planned for a future version.

The goal is to let Fakemon be connected into evolution lines and have their learnsets work together, making it easier to design an entire evolutionary family without having to manually duplicate information.

## Tech

Currently built with:

- HTML
- CSS
- JavaScript
- IndexedDB
- html2canvas

I'm trying to keep the project relatively lightweight and avoid adding a framework or backend unless there's actually a reason to.

## Status

This is still very much a **work in progress**.

Things will probably break. Things will probably get redesigned. Some of the systems are still experimental.

I'm mostly building this because it's fun, but I'm putting it on GitHub in case anyone else finds it useful or wants to poke around the code.

## Contributing

If you find something broken or have an idea, feel free to open an issue or PR.

idrk what to put in here really just suggest things to me

Have fun making weird Pokémon. :3
