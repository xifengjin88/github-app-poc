terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ami" "amazon_linux" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
}

# ---- Network ----

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true

  tags = {
    Name = "${var.name}-vpc"
  }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.name}-public-${count.index}"
  }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name = "${var.name}-private-${count.index}"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

# One NAT gateway per AZ.
resource "aws_eip" "nat" {
  count  = 2
  domain = "vpc"
}

resource "aws_nat_gateway" "main" {
  count         = 2
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  depends_on = [aws_internet_gateway.main]
}

# ---- Compute ----

resource "aws_instance" "web" {
  count         = var.web_instance_count
  ami           = data.aws_ami.amazon_linux.id
  instance_type = "m5.4xlarge"
  subnet_id     = aws_subnet.private[count.index % 2].id

  root_block_device {
    volume_type = "io1"
    volume_size = 500
    iops        = 10000
  }

  tags = {
    Name = "${var.name}-web-${count.index}"
  }
}

# ---- Database ----

resource "aws_db_subnet_group" "main" {
  name       = "${var.name}-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "main" {
  identifier                  = "${var.name}-db"
  engine                      = "postgres"
  engine_version              = "16.4"
  instance_class              = "db.r6g.4xlarge"
  allocated_storage           = 1000
  storage_type                = "gp2"
  multi_az                    = true
  db_subnet_group_name        = aws_db_subnet_group.main.name
  username                    = "app"
  manage_master_user_password = true
  backup_retention_period     = 35
  skip_final_snapshot         = true
}

# ---- Storage / logs ----

resource "aws_s3_bucket" "logs" {
  bucket = "${var.name}-logs"
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.name}/app"
  retention_in_days = 0
}
