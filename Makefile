.PHONY: up down logs ps backup reset-password

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

# Forgot your password? make reset-password EMAIL=you@example.com
reset-password:
	docker compose exec app node dist/cli.js reset-password $(EMAIL)
