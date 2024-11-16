from datetime import datetime, timezone, timedelta, date
from dateutil import parser
from game import Game
from nba_api.live.nba.endpoints import scoreboard
#from nba_api.stats.endpoints import scoreboard as tomorrow_score # Correct endpoint for querying future dates

# Today's Score Board
#board = scoreboard.ScoreBoard()
game = Game()
#game.print_last_score()
print(game.return_json())


###
# 
# 
# 
# print("ScoreBoardDate: " + board.score_board_date)


###
#print(games['scoreboard']['games'][0]['homeTeam']['score'])