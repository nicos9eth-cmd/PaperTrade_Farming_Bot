@echo off
cd /d "%~dp0"
if exist nouveautes-papertrade.txt (
  start "" notepad nouveautes-papertrade.txt
) else (
  echo Aucune mise a jour de Papertrade relevee pour l instant.
  echo Le bot les note toutes seules pendant qu il tourne.
  pause
)
