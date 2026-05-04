.PHONY: pre-deploy deploy restart start stop status logs logs-live sync claude-login claude-fix-perms

DC = docker compose -f docker-compose.production.yml -f docker-compose.override.yml

pre-deploy:
	npm run format
	npm run lint

deploy: pre-deploy
	git add -A
	git commit -m "Update" || true
	git push
	bash deploy/aif.sh

start:
	bash deploy/ssh.sh "cd ~/aif-handoff && $(DC) start"

stop:
	bash deploy/ssh.sh "cd ~/aif-handoff && $(DC) stop"

restart:
	bash deploy/ssh.sh "cd ~/aif-handoff && $(DC) restart"

status:
	bash deploy/ssh.sh "cd ~/aif-handoff && $(DC) ps"

logs:
	bash deploy/ssh.sh "cd ~/aif-handoff && $(DC) logs --tail=50"

logs-live:
	bash deploy/ssh.sh "cd ~/aif-handoff && $(DC) logs -f --tail=100"

sync:
	git fetch upstream && git merge upstream/main && git push origin main

claude-login:
	bash deploy/ssh.sh "cd ~/aif-handoff && $(DC) exec -u node agent claude /login"

claude-fix-perms:
	bash deploy/ssh.sh "cd ~/aif-handoff && $(DC) exec agent chown -R node:node /home/node/.claude/"
