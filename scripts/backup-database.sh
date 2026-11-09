#!/bin/bash
# =============================================================================
# BelivrHQ Database Backup Script
# =============================================================================
# Backs up the PostgreSQL database using pg_dump.
# Supports local Docker and remote (Railway/Fly.io) databases.
#
# Usage:
#   # Local backup (Docker PostgreSQL on port 5433)
#   ./scripts/backup-database.sh local
#
#   # Remote backup (requires DATABASE_URL in .env)
#   ./scripts/backup-database.sh remote
#
#   # Restore from a backup file
#   ./scripts/backup-database.sh restore ./backups/belivrhq_2026-07-22.sql.gz
# =============================================================================

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_FILE="${BACKUP_DIR}/belivrhq_${TIMESTAMP}.sql.gz"
LOG_FILE="${BACKUP_DIR}/backup_${TIMESTAMP}.log"

# Ensure backup directory exists
mkdir -p "${BACKUP_DIR}"

# ─── Colors for output ──────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo -e "[$(date '+%H:%M:%S')] ${GREEN}${1}${NC}" | tee -a "${LOG_FILE}"
}

warn() {
    echo -e "[$(date '+%H:%M:%S')] ${YELLOW}${1}${NC}" | tee -a "${LOG_FILE}"
}

error() {
    echo -e "[$(date '+%H:%M:%S')] ${RED}${1}${NC}" | tee -a "${LOG_FILE}"
    exit 1
}

# ─── Local Backup ───────────────────────────────────────────
backup_local() {
    log "Starting local database backup..."

    local DB_HOST="${DB_HOST:-localhost}"
    local DB_PORT="${DB_PORT:-5433}"
    local DB_NAME="${DB_NAME:-belivrhq}"
    local DB_USER="${DB_USER:-belivrhq}"

    log "Database: ${DB_HOST}:${DB_PORT}/${DB_NAME}"

    PGPASSWORD="${DB_PASSWORD:-belivrhq}" pg_dump \
        -h "${DB_HOST}" \
        -p "${DB_PORT}" \
        -U "${DB_USER}" \
        -d "${DB_NAME}" \
        --clean \
        --if-exists \
        --no-owner \
        --no-acl \
        --compress=9 \
        --verbose \
        2>>"${LOG_FILE}" \
        >"${BACKUP_FILE}"

    log "Local backup completed: ${BACKUP_FILE}"
}

# ─── Remote Backup (from DATABASE_URL) ──────────────────────
backup_remote() {
    log "Starting remote database backup from DATABASE_URL..."

    if [ -z "${DATABASE_URL:-}" ]; then
        error "DATABASE_URL not set. Set it in your .env file or export it."
    fi

    # Extract connection details from DATABASE_URL
    # postgresql://user:password@host:port/dbname
    pg_dump \
        "${DATABASE_URL}" \
        --clean \
        --if-exists \
        --no-owner \
        --no-acl \
        --compress=9 \
        --verbose \
        2>>"${LOG_FILE}" \
        >"${BACKUP_FILE}"

    log "Remote backup completed: ${BACKUP_FILE}"
}

# ─── Restore from Backup ────────────────────────────────────
restore_backup() {
    local RESTORE_FILE="${1}"

    if [ ! -f "${RESTORE_FILE}" ]; then
        error "Backup file not found: ${RESTORE_FILE}"
    fi

    log "Starting restore from: ${RESTORE_FILE}"

    local DB_HOST="${DB_HOST:-localhost}"
    local DB_PORT="${DB_PORT:-5433}"
    local DB_NAME="${DB_NAME:-belivrhq}"
    local DB_USER="${DB_USER:-belivrhq}"

    warn "⚠️  This will DROP existing data and replace it with the backup!"
    warn "   Database: ${DB_HOST}:${DB_PORT}/${DB_NAME}"
    echo ""
    read -p "Are you sure? Type 'yes' to continue: " CONFIRM

    if [ "${CONFIRM}" != "yes" ]; then
        warn "Restore cancelled."
        exit 0
    fi

    if [[ "${RESTORE_FILE}" == *.gz ]]; then
        zcat "${RESTORE_FILE}" | PGPASSWORD="${DB_PASSWORD:-belivrhq}" psql \
            -h "${DB_HOST}" \
            -p "${DB_PORT}" \
            -U "${DB_USER}" \
            -d "${DB_NAME}" \
            2>>"${LOG_FILE}"
    else
        PGPASSWORD="${DB_PASSWORD:-belivrhq}" psql \
            -h "${DB_HOST}" \
            -p "${DB_PORT}" \
            -U "${DB_USER}" \
            -d "${DB_NAME}" \
            -f "${RESTORE_FILE}" \
            2>>"${LOG_FILE}"
    fi

    log "Restore completed from: ${RESTORE_FILE}"
}

# ─── Main ───────────────────────────────────────────────────
case "${1:-help}" in
    local)
        backup_local
        ;;
    remote)
        backup_remote
        ;;
    restore)
        if [ -z "${2:-}" ]; then
            error "Usage: $0 restore <backup-file>"
        fi
        restore_backup "${2}"
        ;;
    help|*)
        echo "BelivrHQ Database Backup Script"
        echo ""
        echo "Usage:"
        echo "  $0 local              Backup local Docker PostgreSQL"
        echo "  $0 remote             Backup from DATABASE_URL (.env)"
        echo "  $0 restore <file>     Restore from a backup file"
        echo "  $0 help               Show this help message"
        echo ""
        echo "Environment variables (local):"
        echo "  DB_HOST       Database host (default: localhost)"
        echo "  DB_PORT       Database port (default: 5433)"
        echo "  DB_NAME       Database name (default: belivrhq)"
        echo "  DB_USER       Database user (default: belivrhq)"
        echo "  DB_PASSWORD   Database password (default: belivrhq)"
        echo ""
        echo "Examples:"
        echo "  ./scripts/backup-database.sh local"
        echo "  DATABASE_URL=\$(grep DATABASE_URL .env | cut -d= -f2-) ./scripts/backup-database.sh remote"
        echo "  ./scripts/backup-database.sh restore ./backups/belivrhq_2026-07-22.sql.gz"
        ;;
esac
