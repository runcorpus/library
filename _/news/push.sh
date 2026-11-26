#!/usr/bin/env bash
set -euo pipefail

corpus push _/news:today
corpus push _/news:thisweek
corpus push _/news:thismonth
corpus push _/news:latest
