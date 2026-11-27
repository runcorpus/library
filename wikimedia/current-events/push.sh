#!/usr/bin/env bash
set -euo pipefail

corpus push wikimedia/current-events:thisweek
corpus push wikimedia/current-events:thismonth
corpus push wikimedia/current-events:thisyear
corpus push wikimedia/current-events:latest
