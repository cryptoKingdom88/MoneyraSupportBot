#!/usr/bin/env python3
"""
Main entry point for the Vector Service application
Can be run with: python -m app
"""

import sys
import os
from pathlib import Path

# Ensure the parent directory is in the Python path
parent_dir = Path(__file__).parent.parent
sys.path.insert(0, str(parent_dir))

if __name__ == "__main__":
    import uvicorn
    from app.main import app
    from app.config import get_settings
    
    settings = get_settings()
    
    # Configure logging
    import logging
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper()),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )
    
    print(f"🚀 Starting Vector Service")
    print(f"📍 Host: {settings.host}")
    print(f"🔌 Port: {settings.port}")
    print(f"📊 Log Level: {settings.log_level}")
    print(f"🗄️ Database: {settings.db_path}")
    print(f"🤖 Model: {settings.model_name}")
    print("-" * 50)
    
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        reload=settings.debug
    )