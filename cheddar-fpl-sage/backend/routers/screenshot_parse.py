"""Screenshot parse router — POST /screenshot-parse."""
import base64

from fastapi import APIRouter

from backend.models.screenshot_api_models import (
    ScreenshotParseRequest,
    ScreenshotParseResponse,
)
from backend.services.screenshot_parser import screenshot_parser

router = APIRouter(prefix="/screenshot-parse", tags=["screenshot-parse"])


@router.post("", response_model=ScreenshotParseResponse)
async def parse_screenshot(request: ScreenshotParseRequest) -> ScreenshotParseResponse:
    """Parse 1-3 base64-encoded FPL mobile screenshots into a structured squad."""
    image_bytes_list = [base64.b64decode(img) for img in request.images]
    squad, layout, warnings = screenshot_parser.parse(image_bytes_list)
    return ScreenshotParseResponse(
        squad=squad,
        layout_detected=layout,
        images_processed=len(image_bytes_list),
        parse_warnings=warnings,
    )
