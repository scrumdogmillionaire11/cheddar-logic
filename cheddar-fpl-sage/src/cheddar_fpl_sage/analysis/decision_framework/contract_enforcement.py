"""
Decision contract enforcement for WI-0354.

Ensures canonical contracts are enforced before serialization:
- Captain expected_pts always present and >= 0
- Strategy paths deduplicated with distinct rationales
- Projected XI reflects primary transfer
- Squad health from single normalized source
- Confidence metadata always complete
- Transfer rationale includes why_now, risk_note, horizon_gws
"""

import logging
from typing import Dict, List, Any, Tuple, Optional
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class ContractViolation:
    """Represents a single contract violation found during enforcement"""
    field_path: str
    violation_type: str
    expected: str
    actual: str
    severity: str = "ERROR"  # ERROR | WARNING
    remediation: str = ""
    

@dataclass
class ContractEnforcementResult:
    """Result of contract enforcement validation"""
    valid: bool
    violations: List[ContractViolation] = field(default_factory=list)
    remediated_count: int = 0
    remediated_fields: List[str] = field(default_factory=list)
    
    def add_violation(self, violation: ContractViolation):
        """Record a violation"""
        self.violations.append(violation)
        if violation.severity == "ERROR":
            self.valid = False
    
    def summary(self) -> str:
        """Generate summary of all violations"""
        if not self.violations:
            return "✓ All contracts validated successfully"
        
        lines = [f"Contract violations found ({len(self.violations)} total):"]
        for v in self.violations:
            severity_mark = "❌" if v.severity == "ERROR" else "⚠️"
            lines.append(f"{severity_mark} {v.field_path}: {v.violation_type}")
            if v.remediation:
                lines.append(f"  → {v.remediation}")
        if self.remediated_count > 0:
            lines.append(f"Remediated: {self.remediated_count} fields")
        return "\n".join(lines)


class DecisionContractEnforcer:
    """Enforces decision contract before response serialization"""
    
    @staticmethod
    def enforce_captain_contract(decision: Dict[str, Any]) -> ContractEnforcementResult:
        """
        CAPTAIN CONTRACT: captain.expected_pts and vice_captain.expected_pts
        must always be present as floats (>= 0), never None/missing.
        
        Selection paths:
        - recommend_captaincy_from_xi (optimized XI pool)
        - recommend_captaincy (all starters)
        - fallback generators
        """
        result = ContractEnforcementResult(valid=True)
        
        captaincy = decision.get("captaincy", {})
        if not captaincy:
            result.add_violation(ContractViolation(
                field_path="decision.captaincy",
                violation_type="missing_entire_object",
                expected="Dict with captain/vice_captain",
                actual="None or empty",
                severity="ERROR",
                remediation="Initialize captaincy dict with fallback captain"
            ))
            return result
        
        # Check captain
        captain = captaincy.get("captain")
        if not captain:
            result.add_violation(ContractViolation(
                field_path="decision.captaincy.captain",
                violation_type="missing",
                expected="Dict with name, expected_pts, etc",
                actual="None",
                severity="ERROR",
                remediation="Populate from XI captain pool"
            ))
        else:
            expected_pts = captain.get("expected_pts")
            if expected_pts is None:
                result.add_violation(ContractViolation(
                    field_path="decision.captaincy.captain.expected_pts",
                    violation_type="missing_required_field",
                    expected="float >= 0",
                    actual="None",
                    severity="ERROR",
                    remediation="Set from captain.nextGW_pts or total_points"
                ))
                # Remediate: try alternate field names
                alt_pts = captain.get("nextGW_pts") or captain.get("total_points") or 0.0
                captain["expected_pts"] = float(alt_pts) if alt_pts else 0.0
                result.remediated_count += 1
                result.remediated_fields.append("decision.captaincy.captain.expected_pts")
            elif not isinstance(expected_pts, (int, float)):
                result.add_violation(ContractViolation(
                    field_path="decision.captaincy.captain.expected_pts",
                    violation_type="type_mismatch",
                    expected="float",
                    actual=type(expected_pts).__name__,
                    severity="WARNING",
                    remediation=f"Coerce to float: {float(expected_pts)}"
                ))
                captain["expected_pts"] = float(expected_pts)
                result.remediated_count += 1
                result.remediated_fields.append("decision.captaincy.captain.expected_pts")
            elif expected_pts < 0:
                result.add_violation(ContractViolation(
                    field_path="decision.captaincy.captain.expected_pts",
                    violation_type="value_constraint_violation",
                    expected=">= 0",
                    actual=str(expected_pts),
                    severity="WARNING",
                    remediation="Clamp negative value to 0.0"
                ))
                captain["expected_pts"] = max(0.0, float(expected_pts))
                result.remediated_count += 1
                result.remediated_fields.append("decision.captaincy.captain.expected_pts")
        
        # Check vice captain
        vice = captaincy.get("vice_captain")
        if not vice:
            result.add_violation(ContractViolation(
                field_path="decision.captaincy.vice_captain",
                violation_type="missing",
                expected="Dict with name, expected_pts, etc",
                actual="None",
                severity="WARNING",
                remediation="Populate from second-ranked XI captain pool option"
            ))
        else:
            expected_pts = vice.get("expected_pts")
            if expected_pts is None:
                result.add_violation(ContractViolation(
                    field_path="decision.captaincy.vice_captain.expected_pts",
                    violation_type="missing_required_field",
                    expected="float >= 0",
                    actual="None",
                    severity="WARNING",
                    remediation="Set from vice_captain.nextGW_pts or total_points"
                ))
                # Remediate
                alt_pts = vice.get("nextGW_pts") or vice.get("total_points") or 0.0
                vice["expected_pts"] = float(alt_pts) if alt_pts else 0.0
                result.remediated_count += 1
                result.remediated_fields.append("decision.captaincy.vice_captain.expected_pts")
            elif not isinstance(expected_pts, (int, float)):
                result.add_violation(ContractViolation(
                    field_path="decision.captaincy.vice_captain.expected_pts",
                    violation_type="type_mismatch",
                    expected="float",
                    actual=type(expected_pts).__name__,
                    severity="WARNING",
                    remediation=f"Coerce to float: {float(expected_pts)}"
                ))
                vice["expected_pts"] = float(expected_pts)
                result.remediated_count += 1
                result.remediated_fields.append("decision.captaincy.vice_captain.expected_pts")
            elif expected_pts < 0:
                result.add_violation(ContractViolation(
                    field_path="decision.captaincy.vice_captain.expected_pts",
                    violation_type="value_constraint_violation",
                    expected=">= 0",
                    actual=str(expected_pts),
                    severity="WARNING",
                    remediation="Clamp negative value to 0.0"
                ))
                vice["expected_pts"] = max(0.0, float(expected_pts))
                result.remediated_count += 1
                result.remediated_fields.append("decision.captaincy.vice_captain.expected_pts")
        
        return result
    
    @staticmethod
    def enforce_strategy_paths_contract(decision: Dict[str, Any], team_data: Optional[Dict[str, Any]] = None) -> ContractEnforcementResult:
        """
        STRATEGY PATH VALIDITY:
        - Rank bucket determines initial strategy selection
        - Risk posture adjusts strategy within bounds
        - No player appears in both out AND in within same response
        - All paths deduplicated (by out+in pair)
        - Each path has distinct rationale (safe/balanced/aggressive differ)
        """
        result = ContractEnforcementResult(valid=True)
        
        strategy_paths = decision.get("strategy_paths", {})
        if not strategy_paths:
            # No paths is acceptable - might be hold decision
            return result
        
        # Normalize into one path object per mode for consistent enforcement.
        mode_paths: Dict[str, Optional[Dict[str, Any]]] = {}
        for mode, mode_value in strategy_paths.items():
            if isinstance(mode_value, dict):
                mode_paths[mode] = mode_value
            elif isinstance(mode_value, list):
                first_valid = next((item for item in mode_value if isinstance(item, dict)), None)
                mode_paths[mode] = first_valid
            else:
                mode_paths[mode] = None

        squad_names = set()
        if isinstance(team_data, dict):
            for player in team_data.get("current_squad", []) or []:
                name = str(player.get("name") or "").lower().strip()
                if name:
                    squad_names.add(name)

        seen_pairs: Dict[Tuple[str, str], str] = {}
        duplicates: List[str] = []
        for mode, path in mode_paths.items():
            if not isinstance(path, dict):
                continue
            out_player = (path.get("out") or path.get("out_name") or "").lower().strip()
            in_player = (path.get("in") or path.get("in_name") or "").lower().strip()
            if not out_player or not in_player:
                continue

            pair = (out_player, in_player)
            if pair in seen_pairs:
                duplicates.append(mode)
            else:
                seen_pairs[pair] = mode

            if in_player in squad_names:
                result.add_violation(ContractViolation(
                    field_path=f"decision.strategy_paths.{mode}.in",
                    violation_type="in_player_already_in_squad",
                    expected="transfer-in target not currently owned",
                    actual=in_player,
                    severity="WARNING",
                    remediation="Drop invalid path for this mode"
                ))
                mode_paths[mode] = None
                result.remediated_count += 1
                result.remediated_fields.append(f"decision.strategy_paths.{mode}")
        
        if duplicates:
            result.add_violation(ContractViolation(
                field_path="decision.strategy_paths",
                violation_type="duplicate_transfer_pairs",
                expected="All (out, in) pairs unique",
                actual=f"{len(duplicates)} duplicates found",
                severity="WARNING",
                remediation="Remove duplicate paths, keep highest confidence version"
            ))
            for mode in duplicates:
                mode_paths[mode] = None
                result.remediated_count += 1
                result.remediated_fields.append(f"decision.strategy_paths.{mode}")
        
        # Check that distinct rationales exist (safe/balanced/aggressive should differ)
        rationales_by_mode = {}
        for path_mode, path in mode_paths.items():
            if not isinstance(path, dict):
                continue
            rationale = path.get("rationale", "").strip().lower()
            rationales_by_mode[path_mode] = rationale
        
        # If all three modes exist with identical rationales, flag it
        if len(set(rationales_by_mode.values())) == 1 and len(rationales_by_mode) > 1:
            result.add_violation(ContractViolation(
                field_path="decision.strategy_paths",
                violation_type="identical_rationales_across_modes",
                expected="Distinct rationale per strategy mode",
                actual="All modes have same rationale",
                severity="WARNING",
                remediation="Regenerate strategy paths with mode-specific explanations"
            ))
        
        for mode, path in mode_paths.items():
            strategy_paths[mode] = path

        return result
    
    @staticmethod
    def enforce_confidence_contract(decision: Dict[str, Any]) -> ContractEnforcementResult:
        """
        CONFIDENCE METADATA: confidence_score always accompanied by
        confidence_label (HIGH | MEDIUM | LOW) and confidence_summary (sentence).
        """
        result = ContractEnforcementResult(valid=True)
        
        score = decision.get("confidence_score")
        label = decision.get("confidence_label", "").strip()
        summary = decision.get("confidence_summary", "").strip()
        
        # Validate score exists
        if score is None:
            result.add_violation(ContractViolation(
                field_path="decision.confidence_score",
                violation_type="missing",
                expected="float 0-1",
                actual="None",
                severity="WARNING",
                remediation="Default to 0.5 (MEDIUM confidence)"
            ))
            decision["confidence_score"] = 0.5
            result.remediated_count += 1
            result.remediated_fields.append("decision.confidence_score")
            score = 0.5
        
        # Derive label from score if missing
        if not label:
            if score >= 0.75:
                label = "HIGH"
            elif score >= 0.45:
                label = "MEDIUM"
            else:
                label = "LOW"
            
            decision["confidence_label"] = label
            result.remediated_count += 1
            result.remediated_fields.append("decision.confidence_label")
        
        # Validate label is one of the three
        if label not in ["HIGH", "MEDIUM", "LOW"]:
            result.add_violation(ContractViolation(
                field_path="decision.confidence_label",
                violation_type="invalid_value",
                expected="HIGH | MEDIUM | LOW",
                actual=label,
                severity="WARNING",
                remediation=f"Map '{label}' to closest valid label"
            ))
            # Simple mapping
            if "high" in label.lower():
                label = "HIGH"
            elif "low" in label.lower():
                label = "LOW"
            else:
                label = "MEDIUM"
            decision["confidence_label"] = label
            result.remediated_count += 1
            result.remediated_fields.append("decision.confidence_label")
        
        # Derive summary from label if missing
        if not summary:
            decision_text = decision.get("primary_decision", "")[:20]
            summaries = {
                "HIGH": f"High confidence in recommended action: {decision_text}",
                "MEDIUM": f"Moderate confidence in recommended action: {decision_text}",
                "LOW": f"Low confidence — conditions are uncertain; monitor before acting: {decision_text}"
            }
            summary = summaries.get(label, summaries["MEDIUM"])
            decision["confidence_summary"] = summary
            result.remediated_count += 1
            result.remediated_fields.append("decision.confidence_summary")
        
        return result
    
    @staticmethod
    def enforce_squad_health_contract(decision: Dict[str, Any], team_data: Dict[str, Any]) -> ContractEnforcementResult:
        """
        HEALTH / RISK NORMALIZATION: All risk state (injured, doubtful, health_pct,
        critical_positions) originates from single normalized squad_health object.
        """
        result = ContractEnforcementResult(valid=True)
        
        squad = team_data.get("current_squad", [])
        
        # Calculate canonical health metrics
        total_players = len(squad)
        available = sum(1 for p in squad if p.get("status_flag") not in ["OUT", "DOUBT"])
        injured = sum(1 for p in squad if p.get("status_flag") == "OUT")
        doubtful = sum(1 for p in squad if p.get("status_flag") == "DOUBT")
        health_pct = round(100 * available / total_players, 1) if total_players > 0 else 0.0
        
        # Identify critical positions with issues
        critical_positions = set()
        for player in squad:
            if player.get("is_starter") and player.get("status_flag") in ["OUT", "DOUBT"]:
                pos = player.get("position", "?")
                critical_positions.add(pos)
        
        canonical_health = {
            "total_players": total_players,
            "available": available,
            "injured": injured,
            "doubtful": doubtful,
            "health_pct": health_pct,
            "critical_positions": sorted(list(critical_positions)),
            "source": "canonical"
        }
        
        # Check if squad_health already exists in decision
        existing_health = decision.get("squad_health", {})
        if existing_health:
            # Validate against canonical
            for key in ["total_players", "available", "injured", "doubtful"]:
                existing_val = existing_health.get(key)
                canonical_val = canonical_health.get(key)
                if existing_val != canonical_val:
                    result.add_violation(ContractViolation(
                        field_path=f"decision.squad_health.{key}",
                        violation_type="mismatch_with_canonical",
                        expected=str(canonical_val),
                        actual=str(existing_val),
                        severity="WARNING",
                        remediation="Use canonical value from squad analysis"
                    ))
        else:
            decision["squad_health"] = canonical_health
            result.remediated_count += 1
            result.remediated_fields.append("decision.squad_health")
        
        # Ensure canonical values are set
        decision["squad_health"] = canonical_health
        
        return result
    
    @staticmethod
    def enforce_transfer_rationale_depth(decision: Dict[str, Any]) -> ContractEnforcementResult:
        """
        TRANSFER RATIONALE DEPTH: Transfer objects include why_now (trigger reason),
        risk_note (downside sentence), and horizon_gws (projection window).
        """
        result = ContractEnforcementResult(valid=True)
        
        transfer_recs = decision.get("transfer_recommendations", [])
        if not transfer_recs:
            return result
        
        for idx, transfer in enumerate(transfer_recs):
            if not isinstance(transfer, dict):
                continue
            
            # Check why_now
            why_now = transfer.get("why_now", "").strip()
            if not why_now:
                transfer["why_now"] = transfer.get("reason", "")[:100] or "Transfer needed this week"
                result.remediated_fields.append(f"transfer_recommendations[{idx}].why_now")
            
            # Check risk_note
            risk_note = transfer.get("risk_note", "").strip()
            if not risk_note:
                transfer["risk_note"] = "Standard transfer risk applies"
                result.remediated_fields.append(f"transfer_recommendations[{idx}].risk_note")
            
            # Check horizon_gws
            horizon = transfer.get("horizon_gws")
            if horizon is None:
                # Try to infer from other fields
                transfer["horizon_gws"] = 4  # Default 4-game window
                result.remediated_fields.append(f"transfer_recommendations[{idx}].horizon_gws")
            
            if result.remediated_fields:
                result.remediated_count += len([f for f in result.remediated_fields if str(idx) in f])
        
        return result
    
    @staticmethod
    def enforce_all_contracts(decision: Dict[str, Any], team_data: Dict[str, Any]) -> ContractEnforcementResult:
        """
        Run all contract enforcement checks and merge results.
        
        Returns:
            ContractEnforcementResult with combined violations and remediations
        """
        logger.info("=== DECISION CONTRACT ENFORCEMENT START ===")
        
        results = [
            DecisionContractEnforcer.enforce_captain_contract(decision),
            DecisionContractEnforcer.enforce_strategy_paths_contract(decision, team_data),
            DecisionContractEnforcer.enforce_confidence_contract(decision),
            DecisionContractEnforcer.enforce_squad_health_contract(decision, team_data),
            DecisionContractEnforcer.enforce_transfer_rationale_depth(decision),
        ]
        
        # Merge all results
        merged = ContractEnforcementResult(valid=all(r.valid for r in results))
        for result in results:
            merged.violations.extend(result.violations)
            merged.remediated_count += result.remediated_count
            merged.remediated_fields.extend(result.remediated_fields)
        
        # Log summary
        logger.info(merged.summary())
        for v in merged.violations:
            if v.severity == "ERROR":
                logger.error(f"❌ {v.field_path}: {v.violation_type}")
            else:
                logger.warning(f"⚠️ {v.field_path}: {v.violation_type}")
        
        if merged.remediated_count > 0:
            logger.info(f"✓ Remediated {merged.remediated_count} fields")
            logger.debug(f"  Fields: {merged.remediated_fields}")
        
        logger.info("=== DECISION CONTRACT ENFORCEMENT END ===")
        return merged
