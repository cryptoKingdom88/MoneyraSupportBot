"""
Data models for Vector Service
Defines request/response models and internal data structures
"""

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
from datetime import datetime
import numpy as np

# Request Models
class VectorAddRequest(BaseModel):
    """Request model for adding new vector data"""
    id: int = Field(..., description="KB entry ID")
    input_text: str = Field(..., description="Input text to vectorize")
    answer: str = Field(..., description="Answer content")

class VectorUpdateRequest(BaseModel):
    """Request model for updating existing vector data"""
    id: int = Field(..., description="KB entry ID")
    input_text: str = Field(..., description="Updated input text")
    answer: str = Field(..., description="Updated answer content")

class VectorDeleteRequest(BaseModel):
    """Request model for deleting vector data"""
    id: int = Field(..., description="KB entry ID to delete")

class VectorSearchRequest(BaseModel):
    """Request model for similarity search"""
    query: str = Field(..., description="Search query text")

# Response Models
class VectorResponse(BaseModel):
    """Standard response for vector operations"""
    success: bool = Field(..., description="Operation success status")
    message: str = Field(..., description="Response message")
    vector_data: Optional[List[float]] = Field(None, description="Generated vector data")

class SearchResponse(BaseModel):
    """Response model for similarity search"""
    success: bool = Field(..., description="Search success status")
    match_found: bool = Field(..., description="Whether a match was found")
    similarity_score: Optional[float] = Field(None, description="Similarity score")
    kb_id: Optional[int] = Field(None, description="Matched KB entry ID")
    answer: Optional[str] = Field(None, description="Matched answer")
    message: str = Field(..., description="Response message")

class HealthResponse(BaseModel):
    """Response model for health check"""
    status: str = Field(..., description="Service status")
    index_size: int = Field(..., description="Number of vectors in index")
    service: str = Field(..., description="Service name")
    version: str = Field(..., description="Service version")

# Internal Data Models
class KBEntry:
    """Internal model for KB entry data"""
    def __init__(self, id: int, category: str, question: str, context: str, answer: str, 
                 create_time: datetime, update_time: datetime):
        self.id = id
        self.category = category
        self.question = question
        self.context = context
        self.answer = answer
        self.create_time = create_time
        self.update_time = update_time
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        return {
            "id": self.id,
            "category": self.category,
            "question": self.question,
            "context": self.context,
            "answer": self.answer,
            "create_time": self.create_time.isoformat() if self.create_time else None,
            "update_time": self.update_time.isoformat() if self.update_time else None
        }

class VectorData:
    """Internal model for vector data"""
    def __init__(self, kb_id: int, embedding: np.ndarray, text_content: str, answer: str):
        self.kb_id = kb_id
        self.embedding = embedding
        self.text_content = text_content
        self.answer = answer
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        return {
            "kb_id": self.kb_id,
            "text_content": self.text_content,
            "answer": self.answer,
            "embedding_shape": self.embedding.shape if self.embedding is not None else None
        }

class SimilarityResult:
    """Internal model for similarity search results"""
    def __init__(self, kb_id: int, similarity_score: float, answer: str, confidence_level: str):
        self.kb_id = kb_id
        self.similarity_score = similarity_score
        self.answer = answer
        self.confidence_level = confidence_level
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        return {
            "kb_id": self.kb_id,
            "similarity_score": self.similarity_score,
            "answer": self.answer,
            "confidence_level": self.confidence_level
        }

# Error Models
class VectorServiceError(Exception):
    """Base exception for vector service errors"""
    def __init__(self, message: str, error_code: str = "VECTOR_SERVICE_ERROR"):
        self.message = message
        self.error_code = error_code
        super().__init__(self.message)

class ModelLoadError(VectorServiceError):
    """Exception for model loading errors"""
    def __init__(self, message: str):
        super().__init__(message, "MODEL_LOAD_ERROR")

class IndexError(VectorServiceError):
    """Exception for FAISS index errors"""
    def __init__(self, message: str):
        super().__init__(message, "INDEX_ERROR")

class DatabaseError(VectorServiceError):
    """Exception for database errors"""
    def __init__(self, message: str):
        super().__init__(message, "DATABASE_ERROR")