#!/bin/bash
# Raspberry Pi Health Check for Cheddar Logic Services
# Monitors: CPU, memory, thermal throttling, disk I/O, and service health
# Usage: ./pi-health-check.sh [INTERVAL_SECONDS]
# Example: ./pi-health-check.sh 5  # checks every 5 seconds

set -e

INTERVAL="${1:-10}"
SERVICE_NAMES=("cheddar-worker" "cheddar-web" "cheddar-fpl-sage")

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Get system specs
CORE_COUNT=$(nproc)
LOAD_THRESHOLD=$CORE_COUNT

header() {
  echo ""
  echo "==============================================="
  echo "$(date '+%Y-%m-%d %H:%M:%S') - Cheddar Logic Pi Health Check"
  echo "==============================================="
}

check_cpu_load() {
  echo ""
  echo "📊 CPU / LOAD:"
  uptime | awk -F'load average:' '{print $2}'
  local load=$(uptime | awk -F'load average:' '{print $2}' | awk '{print $1}')
  local load_int=${load%.*}
  
  if (( $(echo "$load > $LOAD_THRESHOLD" | bc -l) )); then
    echo -e "${RED}⚠️  HIGH LOAD (${load} > ${LOAD_THRESHOLD})${NC}"
  else
    echo -e "${GREEN}✓ Load OK (${load})${NC}"
  fi
}

check_memory() {
  echo ""
  echo "💾 MEMORY:"
  free -h | grep -E "Mem|Swap"
  
  local swap_used=$(free -h | grep Swap | awk '{print $3}')
  if [[ "$swap_used" != "0B" ]]; then
    echo -e "${YELLOW}⚠️  Swap in use: $swap_used${NC}"
  else
    echo -e "${GREEN}✓ No swap pressure${NC}"
  fi
}

check_thermal() {
  echo ""
  echo "🌡️  THERMAL:"
  if command -v vcgencmd &> /dev/null; then
    local temp=$(vcgencmd measure_temp | grep -oP '\K[0-9.]+')
    echo "CPU Temp: ${temp}°C"
    
    local throttled=$(vcgencmd get_throttled | grep -oP 'throttled=0x\K[0-9a-f]+')
    echo "Throttled: 0x${throttled}"
    
    if (( $(echo "$temp > 80" | bc -l) )); then
      echo -e "${RED}⚠️  HIGH TEMPERATURE (${temp}°C)${NC}"
    elif (( $(echo "$temp > 70" | bc -l) )); then
      echo -e "${YELLOW}⚠️  ELEVATED TEMP (${temp}°C)${NC}"
    else
      echo -e "${GREEN}✓ Temp OK${NC}"
    fi
    
    if [[ "0x${throttled}" != "0x0" ]]; then
      echo -e "${RED}⚠️  THROTTLING ACTIVE (0x${throttled})${NC}"
    else
      echo -e "${GREEN}✓ No throttling${NC}"
    fi
  else
    echo "vcgencmd not available (not on RPi?)"
  fi
}

check_disk_io() {
  echo ""
  echo "💿 DISK I/O:"
  if command -v iostat &> /dev/null; then
    iostat -xz 1 2 | tail -n +4 | head -1 | awk '{printf "Device: %s, Util: %s%%, Await: %sms\n", $1, $14, $10}'
  else
    echo "iostat not available (install sysstat: apt install sysstat)"
  fi
  
  echo ""
  echo "Disk Usage:"
  df -h | grep -E "^/dev" | awk '{printf "%s: %s/%s (%s)\n", $6, $3, $2, $5}'
}

check_services() {
  echo ""
  echo "🔧 SERVICE STATUS:"
  for service in "${SERVICE_NAMES[@]}"; do
    local status=$(systemctl is-active "${service}.service" 2>/dev/null || echo "inactive")
    if [[ "$status" == "active" ]]; then
      echo -e "${GREEN}✓${NC} ${service}: ${status}"
    else
      echo -e "${RED}✗${NC} ${service}: ${status}"
    fi
  done
}

check_service_logs() {
  echo ""
  echo "📋 RECENT ERRORS IN SERVICE LOGS:"
  for service in "${SERVICE_NAMES[@]}"; do
    local errors=$(journalctl -u "${service}.service" -n 50 --no-pager 2>/dev/null | grep -iE "error|failed|throttl|killed|oom" | tail -3)
    if [[ -n "$errors" ]]; then
      echo -e "${YELLOW}⚠️  ${service}:${NC}"
      echo "$errors" | sed 's/^/  /'
    fi
  done
  
  # Check dmesg for OOM or throttling
  local system_errors=$(dmesg -T 2>/dev/null | tail -50 | grep -iE "out of memory|killed process|throttl" || true)
  if [[ -n "$system_errors" ]]; then
    echo -e "${RED}⚠️  System Errors:${NC}"
    echo "$system_errors" | sed 's/^/  /' | tail -5
  fi
}

check_scheduler_health() {
  echo ""
  echo "⏰ SCHEDULER HEALTH:"
  
  for service in "${SERVICE_NAMES[@]}"; do
    # Check if service has restarted recently
    local restart_count=$(systemctl show "${service}.service" -p NRestarts --value 2>/dev/null || echo "0")
    if [[ "$restart_count" -gt 0 ]]; then
      echo -e "${YELLOW}⚠️  ${service} has restarted ${restart_count} times${NC}"
    fi
    
    # Check last job run
    local last_unit_state=$(systemctl show "${service}.service" -p StateChangeTimestamp --value 2>/dev/null || echo "unknown")
    if [[ "$last_unit_state" != "unknown" ]]; then
      echo "  Last state change: $last_unit_state"
    fi
  done
}

# Main loop
if [[ "$INTERVAL" -le 0 ]]; then
  echo "INTERVAL must be > 0"
  exit 1
fi

while true; do
  clear
  header
  check_cpu_load
  check_memory
  check_thermal
  check_disk_io
  check_services
  check_service_logs
  check_scheduler_health
  
  echo ""
  echo "Next check in ${INTERVAL}s. Press Ctrl+C to stop."
  sleep "$INTERVAL"
done
