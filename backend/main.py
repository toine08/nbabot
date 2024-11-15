from nba_api.live.nba.endpoints import scoreboard

# Today's Score Board
games = scoreboard.ScoreBoard()


# json
#print(games.get_json())

# dictionary
games = games.get_dict()
team_name = games['scoreboard']['games'][0]['homeTeam']['teamName']
team_city = games['scoreboard']['games'][0]['homeTeam']['teamCity']
team_score = games['scoreboard']['games'][0]['homeTeam']['score']

for games in games['scoreboard']['games']:
    print(games['homeTeam'])
#print(games['scoreboard']['games'][0]['homeTeam']['score'])