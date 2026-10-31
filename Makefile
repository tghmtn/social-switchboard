.PHONY: up down logs ps backup

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f app worker

ps:
	docker compose ps

backup:
	docker compose exec worker node dist/cli.js backup
