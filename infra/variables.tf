variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "fakegreptile-test"
}

variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "web_instance_count" {
  description = "Number of web instances."
  type        = number
  default     = 3
}
