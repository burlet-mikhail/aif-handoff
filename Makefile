.PHONY: deploy restart start stop status logs logs-live sync

deploy:
	bash deploy/aif.sh

start:
	bash deploy/ssh.sh "sudo systemctl start aif-api aif-agent aif-mcp"

stop:
	bash deploy/ssh.sh "sudo systemctl stop aif-api aif-agent aif-mcp"

restart:
	bash deploy/ssh.sh "sudo systemctl restart aif-api aif-agent aif-mcp"

status:
	bash deploy/ssh.sh "sudo systemctl status aif-api aif-agent --no-pager"

logs:
	bash deploy/ssh.sh "sudo journalctl -u aif-api -u aif-agent -n 50 --no-pager"

logs-live:
	bash deploy/ssh.sh "sudo journalctl -u aif-api -u aif-agent -f"

sync:
	git fetch upstream && git merge upstream/main && git push origin main
