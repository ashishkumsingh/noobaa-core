#!/bin/bash
echo "Uninstalling NooBaa"
if [[ $(ps -elf|grep 'systemd+\{0,1\}[ ]\{1,\}[0-9]\{1,\}[ ]\{1,\}1 ') ]]; then
  echo "systemd detected. Disabling service"
  systemctl disable noobaalocalservice
else if [[ -d /etc/init.d ]]; then
  echo "Removing upstart script"
  rm /etc/init/noobaalocalservice.conf
else
  echo "System V in use"

fi

PATH=/usr/local/noobaa:$PATH;
/usr/local/noobaa/node /usr/local/noobaa/src/agent/agent_linux_installer --uninstall

rm -rf /usr/local/noobaa
echo "NooBaa agent removed"
