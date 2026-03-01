import sys
sys.path.insert(0, 'src')
from cheddar_fpl_sage.analysis.decision_framework.output_formatter import OutputFormatter
from unittest.mock import MagicMock

formatter = OutputFormatter()

team_data = {
    'team_info': {'team_name': 'Test Team', 'current_gw': 20},
    'chip_status': {
        'wildcard': True,
        'freehit': False,
        'bboost': False,
        'triple_captain': True
    },
    'active_chip': 'bboost',
    'current_gameweek': 20,
    'next_gameweek': 21,
    'picks_gameweek': 20
}

decision_output = MagicMock()
decision_output.decision_status = 'PASS'
decision_output.primary_decision = 'HOLD_TRANSFERS'
decision_output.captaincy = None
decision_output.transfer_recommendations = []
decision_output.chip_guidance = None
decision_output.risk_scenarios = []
decision_output.reasoning = ''
decision_output.risk_posture = 'BALANCED'

summary = formatter.generate_decision_summary(decision_output, team_data)
print("=== CHIP LINES ===")
for line in summary.split('\n'):
    if 'chip' in line.lower() or 'available' in line.lower():
        print(line)
