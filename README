# NBA Bot

This project is an NBA bot that fetches and posts NBA game scores and standings. It uses the `nba_api` library to fetch data from the NBA API and posts the results to a social media platform using the `@atproto/api` library.

## Features

- Fetches and posts the last game's scores.
- Fetches and posts the standings for both the Eastern and Western conferences.
- Fetches and posts the future games planned for tonight.
- Posts the results in a thread if the content exceeds the character limit.

## Prerequisites

- Deno installed on your machine.
- An account on the social media platform you are posting to.
- Environment variables set up for your social media account credentials.

## Installation

1. Clone the repository:
    ```sh
    git clone https://github.com/toine08/nbabot
    ```
2. Install the dependencies:
    ```sh
    deno install
    ```
3. Create a `.env` file in the root directory and add your social media account credentials.

## Usage

Run the bot:
```sh
deno tasks run
```
The bot will fetch and post the last game's scores, standings, and future games planned for tonight.

## Project Structure

- `main.ts`: The main entry point for the bot.
- `game.py`: Contains the Game class with methods to fetch and process NBA data.
- `standing.json`: JSON file containing the standings data.
- `last_games_score.json`: JSON file containing the last game's scores.
- `future_games.json`: JSON file containing the future games planned for tonight.

## Methods

- `get_last_games_score`: Fetches the last game's scores and returns them as a list of formatted strings.
- `get_futur_games`: Fetches the future games planned for tonight and returns them as a list of formatted strings.
- `return_standings`: Fetches the standings for both the Eastern and Western conferences and returns them as a dictionary.
- `return_json`: Fetches the last game's scores, standings, and future games planned for tonight and writes them to JSON files.
- `create_post_planned_games`: Splits the planned games into chunks and posts them in a thread.

## Scheduling

The bot uses the `cron` library to schedule tasks. The following schedules are set up:

- Every Monday at 8 AM: Posts the standings.
- Every day at 7 AM: Posts the future games planned for tonight.

## License

This project is licensed under the MIT License. See the LICENSE file for details.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request if you have any improvements or bug fixes.

## Acknowledgements

- `nba_api` for providing the NBA API.
- `@atproto/api` for providing the social media API.
- `Deno` for providing a modern runtime for JavaScript and TypeScript.