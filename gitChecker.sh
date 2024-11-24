#!/bin/bash

git fetch 

output=$(git pull)

timestamp=$(date '+%Y-%m-%d %H:%M') 
commit=$(git show --pretty=format:%s -s HEAD)


if [ ["$output" == "Already up to date."] ]; then
	echo "[$timestamp] The repo is already up to date" >> gitChecker.log
else
	echo "[$timestamp] New commit found on repo: $commit "
	pkill -f nohup
	echo "[$timestamp] All nohup session have been killed"
	echo "[$timestamp] The repo has been updated" >> gitChecker.log
    	nohup deno task run &> output.log &
	echo "[$timestamp] nohup has been executed" >> gitChecker.log
fi
