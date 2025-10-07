"""
Configuration management for Vector Service
Handles environment variables and service settings
"""

import os
from typing import Optional
from pydantic_settings import BaseSettings
from pydantic import Field
from functools import lru_cache
from dotenv import load_dotenv
import os

# Force load .env files with explicit paths
def load_env_files():
    """Load environment files with explicit paths"""
    current_dir = os.path.dirname(os.path.abspath(__file__))
    vector_service_dir = os.path.dirname(current_dir)
    project_root = os.path.dirname(vector_service_dir)
    
    # Load parent .env first
    parent_env = os.path.join(project_root, '.env')
    if os.path.exists(parent_env):
        load_dotenv(parent_env, override=True)
    
    # Load local .env (higher priority)
    local_env = os.path.join(vector_service_dir, '.env')
    if os.path.exists(local_env):
        load_dotenv(local_env, override=True)

# Load environment files
load_env_files()

class Settings(BaseSettings):
    """Application settings loaded from environment variables"""
    
    # Service configuration
    host: str = Field(default="0.0.0.0", env="HOST")
    port: int = Field(default=8000, env="PORT")
    debug: bool = Field(default=False, env="DEBUG")
    log_level: str = Field(default="INFO", env="LOG_LEVEL")
    
    # Database configuration
    db_path: str = Field(default="./data/support.db", env="DB_PATH")
    
    # Model configuration
    model_name: str = Field(
        default="sentence-transformers/all-MiniLM-L6-v2", 
        env="MODEL_NAME"
    )
    similarity_threshold: float = Field(default=0.7, env="SIMILARITY_THRESHOLD")
    faiss_index_type: str = Field(default="IndexFlatIP", env="FAISS_INDEX_TYPE")
    
    # Performance settings
    max_cache_size: int = Field(default=1000, env="MAX_CACHE_SIZE")
    embedding_dimension: int = Field(default=384, env="EMBEDDING_DIMENSION")
    
    def __init__(self, **kwargs):
        # Ensure .env files are loaded before initialization
        load_env_files()
        super().__init__(**kwargs)
        
        # Debug: Print what we actually got
        print(f"🔧 Settings initialized:")
        print(f"   DB_PATH from env: {os.environ.get('DB_PATH', 'NOT SET')}")
        print(f"   db_path in settings: {self.db_path}")
    
    class Config:
        env_file_encoding = "utf-8"
        case_sensitive = False
        extra = "ignore"  # Ignore extra environment variables

@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance"""
    return Settings()

def validate_settings() -> None:
    """Validate required settings and environment"""
    settings = get_settings()
    
    # Validate database path
    if not os.path.exists(os.path.dirname(settings.db_path)):
        raise ValueError(f"Database directory does not exist: {os.path.dirname(settings.db_path)}")
    
    # Validate similarity threshold
    if not 0.0 <= settings.similarity_threshold <= 1.0:
        raise ValueError("Similarity threshold must be between 0.0 and 1.0")
    
    # Validate port
    if not 1 <= settings.port <= 65535:
        raise ValueError("Port must be between 1 and 65535")
    
    # Validate log level
    valid_log_levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
    if settings.log_level.upper() not in valid_log_levels:
        raise ValueError(f"Log level must be one of: {valid_log_levels}")

if __name__ == "__main__":
    # Test configuration loading
    try:
        validate_settings()
        settings = get_settings()
        print("Configuration loaded successfully:")
        print(f"  Host: {settings.host}")
        print(f"  Port: {settings.port}")
        print(f"  Database: {settings.db_path}")
        print(f"  Model: {settings.model_name}")
        print(f"  Similarity Threshold: {settings.similarity_threshold}")
    except Exception as e:
        print(f"Configuration error: {e}")
        exit(1)