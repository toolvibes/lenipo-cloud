#!/bin/sh
# The database of the cloud service; the instances get theirs from the service.
set -e
psql -v ON_ERROR_STOP=1 --username postgres <<SQL
create role cloud login password '$CLOUD_DB_PASSWORD';
create database cloud owner cloud;
SQL
