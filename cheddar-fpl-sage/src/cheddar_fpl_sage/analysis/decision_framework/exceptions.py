"""
Exception hierarchy for FPL Sage decision framework.

Provides domain-specific exceptions that enable targeted error handling
while keeping system exceptions separate.
"""


class FPLSageError(Exception):
    """Base exception for all FPL Sage errors"""
    pass


class DataValidationError(FPLSageError):
    """Invalid data structure or missing required fields"""
    pass


class ConfigurationError(FPLSageError):
    """Config file invalid or cannot be loaded"""
    pass


class PlayerNotFoundError(FPLSageError):
    """Player ID or name lookup failed"""
    pass


class ProjectionMissingError(FPLSageError):
    """Required projection data not available"""
    pass


class ChipAnalysisError(FPLSageError):
    """Chip decision logic failed"""
    pass


class TransferValidationError(FPLSageError):
    """Transfer violates squad rules"""
    pass


class FormationError(FPLSageError):
    """Cannot form valid XI with current squad"""
    pass
