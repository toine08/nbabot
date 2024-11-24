from datetime import datetime, timezone, timedelta, date
import json
import os
from colorist import Color
import pytz
from dateutil import parser,tz
from nba_api.live.nba.endpoints import scoreboard
from nba_api.stats.static import teams
from nba_api.stats.endpoints import scoreboardv2,leaguestandings


class Game():
    def __init__(self):
        self.local_timzone = pytz.timezone("Europe/Zurich")
        self.time_format = "%Y.%m.%d, %H:%M"

    def log(self,message, type):
        now = datetime.now().astimezone(self.local_timzone).strftime(self.time_format)
        if type == "error":
            print(f"[{now}] {Color.RED}{message}{Color.OFF}")
        if type == "success":
            print(f"[{now}] {Color.GREEN}{message}{Color.OFF}")
        else:
            print(f"[{now}] {message}")

    def parse_game_time(self,raw_time, game_date):
        # Remove the " ET" suffix
        clean_time = raw_time.replace(" ET", "")
        
        # Combine date and time
        try:
            # Parse time
            est_time = datetime.strptime(f"{game_date} {clean_time}", "%Y-%m-%d %I:%M %p")
            
            # Assume EST (Eastern Standard Time) for the parsed time
            est = pytz.timezone("US/Eastern")
            est_datetime = est.localize(est_time)
            
            # Convert to UTC
            utc_datetime = est_datetime.astimezone(pytz.utc)
            
            # Convert to Local Time (e.g., Switzerland)
            local_datetime = utc_datetime.astimezone(self.local_timzone)
            
            return {
                "game_datetime_est": est_datetime,
                "game_datetime_utc": utc_datetime,
                "game_datetime_local": local_datetime
            }
        except Exception as e:
            self.log("Error parsing game time '{raw_time}': {e}", "error")
            return None
    
    def get_standings(self):
        standings = leaguestandings.LeagueStandings()
        return standings.get_normalized_dict()
        
    def return_standings(self):
        east_standings = []
        west_standings = []
        standings_raw = self.get_standings()

        # Assuming 'Standings' is a list of teams
        standings_list = standings_raw.get('Standings', [])

        for team in standings_list:
            # Access the 'TeamID' within each entry in the standings list
            team_id = team.get('TeamID', None)
            conference = team.get('Conference', None)
            if team_id:
                team_name = self.get_team_by_id(team_id)
                team_record = f"{team_name}, {team.get('WINS')}-{team.get('LOSSES')}"
                if conference == 'East':
                    east_standings.append(team_record)
                elif conference == 'West':
                    west_standings.append(team_record)
            else:
                self.log("No team ID found for this entry", "error")

        return {'East': east_standings, 'West': west_standings}
                     
    def get_team_by_id(self,id):
        teamName = teams.find_team_name_by_id(id)
        if len(teamName["full_name"])>12:
            return teamName["nickname"]
        else:
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
        f = """--\n{awayTeam}: {awayScore}\n{homeTeam}: {homeScore}\n--"""

        for game in games:
            # Parse game details

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
        if not results:
            results = "No games planned"
        return results
    
    def print_last_score(self):
        results = self.get_last_games_score()
        for result in results:
            print(result, "\n")

    def get_futur_games(self):
        planned_games = []
        today = datetime.now(timezone.utc)  # Ensure 'today' is timezone-aware
        today_str = today.strftime(self.time_format)

        board = scoreboardv2.ScoreboardV2(game_date=today_str)
        games = board.get_normalized_dict()['GameHeader']

        f = "{awayTeam} vs. {homeTeam} @ {gameTimeLTZ}"
        est = pytz.timezone('US/Eastern')

        for game in games:
            game_status = game["GAME_STATUS_TEXT"]
            if "Final" not in game_status:
                game_time_str = game["GAME_STATUS_TEXT"].replace(" ET", "")
                game_date_str = game["GAME_DATE_EST"].split("T")[0]
                game_time = f"{game_date_str} {game_time_str}"
                try:
                    # Parse naive datetime and localize to Eastern Time
                    est_time = est.localize(datetime.strptime(game_time, "%Y-%m-%d %I:%M %p"))

                    # Convert directly to Zurich timezone
                    gameTimeLTZ = est_time.astimezone(self.local_timzone)

                    # Format time in Zurich timezone
                    gameTimeFormatted = gameTimeLTZ.strftime('%H:%M')

                    # Append the formatted string
                    planned_games.append(
                        f.format(
                            awayTeam=self.get_team_by_id(game['VISITOR_TEAM_ID']),
                            homeTeam=self.get_team_by_id(game['HOME_TEAM_ID']),
                            gameTimeLTZ=gameTimeFormatted
                        )
                    )
                except ValueError as e:
                    self.log("Error parsing game time '{game_time}': {e}", "error")

        if not planned_games:
            planned_games.append("No game planned")
        return planned_games



    def return_json(self):
        results = self.get_last_games_score()
        standing = self.return_standings()
        future_games = self.get_futur_games()

        # Get the directory of the current script
        backend_dir = os.path.dirname(os.path.abspath(__file__))

        # Define file paths
        last_games_score_path = os.path.join(backend_dir, "last_games_score.json")
        standing_path = os.path.join(backend_dir, "standing.json")
        future_games_path = os.path.join(backend_dir, "future_games.json")

        # Write JSON files
        with open(last_games_score_path, "w") as outfile:
            json.dump(results, outfile, indent=4)
        with open(standing_path, 'w') as outfile:
            json.dump(standing, outfile, indent=4)
        with open(future_games_path, 'w') as outfile:
            json.dump(future_games, outfile, indent=4)

        self.log("JSON has been exported", "success")
        
