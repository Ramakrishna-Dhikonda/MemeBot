output "redis_public_ip" {
  description = "Public IP for the Redis droplet."
  value       = digitalocean_droplet.redis.ipv4_address
}

output "postgres_public_ip" {
  description = "Public IP for the PostgreSQL droplet."
  value       = digitalocean_droplet.postgres.ipv4_address
}

output "app_public_ip" {
  description = "Public IP for the app droplet."
  value       = digitalocean_droplet.app.ipv4_address
}
