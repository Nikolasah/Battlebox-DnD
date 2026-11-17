# BattleBox: Business Requirements

As of 17 November 2026. Companion documents: [Flow](FLOW.md) and [ERD](ERD.md).

## Summary

BattleBox is a self-hosted web app that runs D&D 5e combat for one remote group. The DM controls the fight from a private console and shares a table screen on the call, and players use their phones as controllers.

This document sets out the business requirements for version 1. Every requirement listed here is built in version 1 unless it sits under "Out of scope and later".

## Background and problem

Combat is the slowest part of a remote session because one person tracks everything by hand. The DM keeps initiative, hit points and conditions in notes, and players on the call cannot see whose turn it is or how hurt anyone is.

Secrets are also hard to keep. A hidden enemy, a private roll or a player's secret decision has to travel through side messages.

Party games like Jackbox solve a similar problem with one shared screen and a phone per player, joined by a short code with no install. BattleBox applies that model to a D&D fight.

## Goals and success measures

The measures are checks you can run at a session, not targets with numbers; none have been measured with real players yet.

| Goal | How we will know |
| --- | --- |
| Everyone can see the state of the fight | The table screen always shows whose turn it is, who is next, the round, party HP and conditions |
| Players take part without setup | A player joins from a phone browser with a four-letter code, with no account and no install |
| Less bookkeeping for the DM | Damage is one number and one key; enemies come from a lookup; the party loads from sheet files |
| The DM keeps secrets | Hidden enemies, private rolls and secret answers never appear on a player's screen |
| Nothing is lost | A restart mid-fight resumes where it stopped; characters carry over to the next session |
| It runs on the DM's own hardware | One container, reachable by remote players through a free tunnel |

## Scope

Version 1 covers combat only, for one DM and one trusted group.

- Rooms joined by a four-letter code, with a private DM link
- Initiative, turn order and round tracking
- Hit points, temporary hit points and the 15 standard conditions
- Enemies added by hand or from a stat-block lookup, including hidden enemies
- Character import from YAML or JSON sheets, D&D Beyond links, or typed numbers
- Dice rolled from phones and shown on the table screen
- One secret-choice prompt at a time
- Saving to disk and a Docker deployment

## Users and roles

There are three roles, and each is a different screen on the same room.

| Role | Screen | How they get in | What they can do |
| --- | --- | --- | --- |
| DM | DM console, on a laptop | Private DM link created with the table | Everything: add and edit combatants, change HP, run turns, roll privately, send prompts, reveal or hide |
| Player | Phone controller | Four-letter room code | Add or claim one character, roll initiative, roll dice, end their own turn, answer prompts |
| Table | Table screen, shared on the call | Open link with the room code | View only: turn order, current turn, HP, conditions, dice, revealed answers |

## Business requirements

Fourteen requirements define version 1.

| ID | Requirement | Priority |
| --- | --- | --- |
| BR-01 | The DM runs a whole fight from one private console | Must |
| BR-02 | A shared table screen shows turn order, the current turn, the round, HP and conditions | Must |
| BR-03 | Players join from a phone browser with a four-letter code, with no account and no install | Must |
| BR-04 | Each player rolls their own initiative, and the roll animates on the table screen | Must |
| BR-05 | The DM adds enemies by hand or from a stat-block lookup, several at a time | Must |
| BR-06 | Characters come in from a YAML or JSON sheet, a D&D Beyond link, or typed numbers | Must |
| BR-07 | Importing an edited sheet again updates the same character instead of adding a copy | Should |
| BR-08 | Only the DM changes hit points, with one number and one key per change | Must |
| BR-09 | Hidden enemies, enemy rolls, exact enemy HP and private DM rolls never reach a player's screen | Must |
| BR-10 | Players roll dice from their phone onto the table screen | Should |
| BR-11 | The DM can ask a secret-choice question and decide whether to reveal the answers | Should |
| BR-12 | The acting player is told on their phone and can end their own turn | Should |
| BR-13 | A table survives a server restart and keeps its characters for the next session | Must |
| BR-14 | The app runs as one container on the DM's hardware and is reachable by remote players over HTTPS | Must |

## Functional requirements

Each screen has its own job, and the server enforces the rules for all three.

### DM console

- Create a table and receive a room code and a private DM link
- Add enemies with name, HP, AC, initiative modifier and count; mark them hidden; reveal them later
- Search open-licence stat blocks and fill the enemy form from a result
- Import one or many character sheet files; a matching name updates the existing character
- Call for initiative, roll for anyone who is away, and start combat
- Advance or step back the turn; the N key advances it
- Apply damage (Enter) or healing (Shift+Enter) per combatant; temporary HP is spent first
- Add and remove conditions; edit any stat; remove a combatant
- Roll dice privately or onto the table screen
- Send a prompt with up to four options or a write-in, watch answers arrive, then reveal or close
- End combat, which removes enemies and keeps characters with their current HP

### Phone controller

- Join with the room code and a name
- Add a character by sheet file, pasted sheet, D&D Beyond link or typed numbers, or claim a saved one
- Roll initiative when the DM calls for it
- Roll d4 to d20 with a modifier, advantage or disadvantage, labelled Attack, Damage, Save or Check
- See own HP, AC and conditions; get a buzz and an "End my turn" button on their turn
- Answer a prompt and change the answer until the DM closes it

### Table screen

- Lobby: the join address, the room code and who has joined
- Initiative: a tile per character that shows the total only after its die lands
- Combat: turn order starting from whoever is acting, the current turn large, and who is up next
- Dice rolls as animated cards, and the last three public log lines
- Prompt: who has locked in, and the answers once revealed

### Server

- Keep one authoritative state per room and push each screen only what it may see
- Save the room to disk after every change
- Reconnect a phone to its character after a refresh or a dropped connection

## Visibility rules

The server filters data per role before sending it, so a player's browser never receives what it must not show.

| Information | DM console | Table screen and phones |
| --- | --- | --- |
| Hidden enemies | Shown | Not sent, not even the name |
| Enemy hit points | Exact | Healthy, Bloodied, Critical or Down; the DM can switch to exact |
| Enemy initiative rolls | Shown | Position in the order only |
| A hidden enemy's turn | Named | "An unseen foe acts" |
| Character HP, AC and conditions | Shown | Shown |
| Secret-choice answers | Live as they arrive | Only who has answered, until the DM reveals |
| Private DM rolls | Shown | Not sent |
| DM link secret and phone keys | Never sent to any screen | Never sent to any screen |

## Non-functional requirements

These are the limits and guarantees the current build holds to.

| Area | Requirement |
| --- | --- |
| Privacy | Visibility is enforced on the server, per role, before data is sent |
| Access | No accounts. The DM link carries a random 32-character secret after the # in the address. Each phone holds a random key that ties it to its character |
| Input safety | Names and answers are always rendered as text. Messages are capped at 64 KB, uploads at 4 MB, and a sheet at 1 MB |
| Reliability | A room is written to disk within about a quarter of a second of each change, as a whole file swapped in at once. Screens reconnect by themselves |
| Capacity | Up to 12 player characters per table, 20 enemies per add, and 200 saved tables per server (configurable) |
| Deployment | One Docker container on Node 22, port 3000, one data volume. Cloudflare Tunnel profiles are included for remote players |
| Devices | Phone and desktop browsers, with no build step and no install. Tested in Chrome only so far |
| Motion | Dice animations are skipped when the device asks for reduced motion |

## Assumptions, constraints and risks

The design leans on one assumption above all: the group is small and trusts each other.

| Type | Item | What follows from it |
| --- | --- | --- |
| Assumption | One trusted group uses the server | Anyone who can reach the site can create a table, and a player can claim any saved character nobody is holding |
| Assumption | The DM shares the table screen through the call's screen share | The app does not carry voice or video |
| Constraint | D&D Beyond import reads an unofficial data format | It can break without notice; sheet files and typed numbers are the fallback |
| Constraint | Monster lookup needs the server to reach Open5e | Without internet access, enemies are added by hand |
| Constraint | Sheet numbers are used as written | Nothing is recalculated from equipment or level |
| Risk | The DM link leaks | Anyone with it sees hidden information. There is no way to rotate it; create a new table |
| Risk | The host machine is down on session night | State is on disk, so a restart resumes the fight |
| Not yet verified | Live D&D Beyond import, live monster lookup and the tunnel profiles | These could not be run in the build sandbox and need one check on real hardware |

## Out of scope and later

Version 1 leaves these out on purpose.

- Maps, tokens and movement
- Spell slots, death-save tracking and legendary actions
- Accounts, several DMs per table, and public hosting for other groups
- Whispers from the DM to one player (the group uses Discord messages)
- A round timer, party votes, hidden player rolls and buzz-in rounds

Three ideas are candidates for a later version.

- Writing updated hit points back into each character's YAML sheet after a session
- Wrapping the app as a Discord Activity, so players join from the voice call without a code
- Saved encounters, so a prepared group of enemies loads in one click
