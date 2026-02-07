variable "do_token" {
  description = "DigitalOcean API token."
  type        = string
  sensitive   = true
}

variable "region" {
  description = "DigitalOcean region."
  type        = string
  default     = "nyc3"
}

variable "ssh_key_fingerprints" {
  description = "SSH key fingerprints to install on the droplets."
  type        = list(string)
}

variable "redis_size" {
  description = "Droplet size for Redis."
  type        = string
  default     = "s-1vcpu-1gb"
}

variable "postgres_size" {
  description = "Droplet size for PostgreSQL."
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "app_size" {
  description = "Droplet size for application services."
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "db_name" {
  description = "PostgreSQL database name."
  type        = string
  default     = "portfolio"
}

variable "db_user" {
  description = "PostgreSQL user name."
  type        = string
  default     = "postgres"
}

variable "db_password" {
  description = "PostgreSQL password."
  type        = string
  sensitive   = true
  default     = "postgres"
}

variable "repo_url" {
  description = "Git repository URL for the app services."
  type        = string
}

variable "repo_branch" {
  description = "Git branch to deploy."
  type        = string
  default     = "main"
}
