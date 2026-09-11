#!/bin/sh
set -eu
docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /var/lib/infinite-canvas-acme:/var/www/acme \
  certbot/certbot:latest renew --quiet --no-random-sleep-on-renew
docker exec infinite-canvas-gateway nginx -t
docker exec infinite-canvas-gateway nginx -s reload
