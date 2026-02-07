terraform {
  required_version = ">= 1.5.0"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.40"
    }
  }
}

provider "digitalocean" {
  token = var.do_token
}

resource "digitalocean_droplet" "redis" {
  name       = "memebot-redis"
  region     = var.region
  size       = var.redis_size
  image      = "ubuntu-22-04-x64"
  ssh_keys   = var.ssh_key_fingerprints
  user_data  = file("${path.module}/cloud-init-redis.yaml")
  monitoring = true
  tags       = ["memebot", "redis"]
}

resource "digitalocean_droplet" "postgres" {
  name       = "memebot-postgres"
  region     = var.region
  size       = var.postgres_size
  image      = "ubuntu-22-04-x64"
  ssh_keys   = var.ssh_key_fingerprints
  user_data  = templatefile("${path.module}/cloud-init-postgres.yaml", {
    db_name     = var.db_name
    db_user     = var.db_user
    db_password = var.db_password
  })
  monitoring = true
  tags       = ["memebot", "postgres"]
}

resource "digitalocean_droplet" "app" {
  name       = "memebot-app"
  region     = var.region
  size       = var.app_size
  image      = "ubuntu-22-04-x64"
  ssh_keys   = var.ssh_key_fingerprints
  user_data  = templatefile("${path.module}/cloud-init-app.yaml", {
    repo_url    = var.repo_url
    repo_branch = var.repo_branch
    app_compose = indent(6, templatefile("${path.module}/app-compose.yml", {
      redis_host    = digitalocean_droplet.redis.ipv4_address
      postgres_host = digitalocean_droplet.postgres.ipv4_address
      db_name       = var.db_name
      db_user       = var.db_user
      db_password   = var.db_password
    }))
  })
  monitoring = true
  tags       = ["memebot", "app"]
}
