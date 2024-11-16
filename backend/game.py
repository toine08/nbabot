from datetime import datetime, timezone, timedelta, date
import json
from dateutil import parser
from nba_api.live.nba.endpoints import scoreboard
from nba_api.stats.static import teams
from nba_api.stats.endpoints import scoreboardv2 # Correct endpoint for querying future dates



class Game():
    def __init__(self):
        pass

    def get_team_by_id(self,id):
        teamName = teams.find_team_name_by_id(id)
        return teamName['full_name']
        
    def get_last_games_score(self):
        results=[]
        # Get yesterday's date
        today = datetime.now()
        yesterday = today - timedelta(days=1)
        yesterday_str = yesterday.strftime('%Y-%m-%d')

        # Fetch game data from Scoreboard
        board = scoreboardv2.ScoreboardV2(game_date=yesterday_str)
        games = board.get_normalized_dict()['GameHeader']
        linescores = board.get_normalized_dict()['LineScore']

        # Format string for output
        f = """--{awayTeam}:{awayScore}\n{homeTeam}:{homeScore}\n--"""

        for game in games:
            # Parse game details

            gameTimeLTZ = parser.parse(game['GAME_DATE_EST']).replace(tzinfo=timezone.utc).astimezone(tz=None)
            gameTimeFormatted = gameTimeLTZ.strftime('%Y-%m-%d %H:%M')

            # Extract scores from LineScore data
            away_team_id = game['VISITOR_TEAM_ID']
            home_team_id = game['HOME_TEAM_ID']
            away_score = next((line['PTS'] for line in linescores if line['TEAM_ID'] == away_team_id and line['TEAM_ABBREVIATION']), 0)
            home_score = next((line['PTS'] for line in linescores if line['TEAM_ID'] == home_team_id and line['TEAM_ABBREVIATION']), 0)

            # Print formatted result
            results.append(
                f.format(
                    awayTeam=self.get_team_by_id(away_team_id),
                    homeTeam=self.get_team_by_id(home_team_id),
                    awayScore=away_score,
                    homeScore=home_score,
                )
            )
        return results
    
    def print_last_score(self):
        results = self.get_last_games_score()
        print("Result of the night:")
        for result in results:
            print(result, "\n")

    def return_json(self):
        results = self.get_last_games_score()
        with open("last_games_score.json", "w") as outfile:
            json.dump(results, outfile, indent=4)

    def get_futur_games(self):
        board = scoreboard.ScoreBoard()
        games = board.games.get_dict()

        f = "{awayTeam} vs. {homeTeam} @ {gameTimeLTZ}" 
        for game in games:
            gameTimeLTZ = parser.parse(game["gameTimeUTC"]).replace(tzinfo=timezone.utc).astimezone(tz=None)
            gameTimeFormatted = gameTimeLTZ.strftime('%Y-%m-%d %H:%M')
            print(f.format(awayTeam=game['awayTeam']['teamName'], homeTeam=game['homeTeam']['teamName'], gameTimeLTZ=gameTimeFormatted))
