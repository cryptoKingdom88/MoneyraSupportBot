"""
FastAPI Vector Service Main Application
Provides vector embedding and similarity search capabilities for KB management
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import logging
from contextlib import asynccontextmanager
from datetime import datetime

from app.config import get_settings
from app.vector_manager import VectorManager
from app.kb_loader import KBDataLoader
from app.models import (
    VectorAddRequest, VectorUpdateRequest, VectorDeleteRequest, VectorSearchRequest,
    VectorResponse, SearchResponse, VectorServiceError
)

# Global instances
vector_manager: VectorManager = None
kb_loader: KBDataLoader = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager for startup and shutdown"""
    global vector_manager, kb_loader
    
    settings = get_settings()
    logging.info("Starting Vector Service...")
    
    try:
        # Initialize KB data loader
        kb_loader = KBDataLoader(settings.db_path)
        
        # Initialize vector manager
        vector_manager = VectorManager(
            model_name=settings.model_name,
            similarity_threshold=settings.similarity_threshold,
            index_type=settings.faiss_index_type,
            max_cache_size=settings.max_cache_size
        )
        
        # Load existing KB data and build index
        kb_entries = kb_loader.load_all_kb_entries()
        await vector_manager.initialize_index(kb_entries)
        
        logging.info(f"Vector Service started successfully with {len(kb_entries)} KB entries")
        
    except Exception as e:
        logging.error(f"Failed to initialize Vector Service: {e}")
        raise
    
    yield
    
    # Cleanup on shutdown
    logging.info("Shutting down Vector Service...")

# Create FastAPI app with lifespan
app = FastAPI(
    title="KB Vector Service",
    description="Vector embedding and similarity search service for knowledge base management",
    version="1.0.0",
    lifespan=lifespan
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health_check():
    """
    Health check endpoint with service status and index size information
    Includes database connectivity and model loading status checks
    """
    try:
        health_status = {
            "status": "healthy",
            "service": "vector-service",
            "version": "1.0.0",
            "timestamp": datetime.now().isoformat(),
            "checks": {}
        }
        
        # Check vector manager initialization
        if not vector_manager:
            health_status["status"] = "unhealthy"
            health_status["checks"]["vector_manager"] = {
                "status": "failed",
                "message": "Vector manager not initialized"
            }
            raise HTTPException(status_code=503, detail=health_status)
        
        # Get vector manager stats
        stats = vector_manager.get_stats()
        health_status["index_size"] = stats["index_size"]
        health_status["cache_size"] = stats["cache_size"]
        health_status["embedding_dimension"] = stats["embedding_dimension"]
        health_status["model_name"] = stats["model_name"]
        health_status["similarity_threshold"] = stats["similarity_threshold"]
        
        # Check vector manager components
        health_status["checks"]["vector_manager"] = {
            "status": "healthy",
            "message": "Vector manager initialized successfully"
        }
        
        # Check model loading status
        if vector_manager.sentence_transformer is None:
            health_status["status"] = "unhealthy"
            health_status["checks"]["model_loading"] = {
                "status": "failed",
                "message": "SentenceTransformer model not loaded"
            }
        else:
            health_status["checks"]["model_loading"] = {
                "status": "healthy",
                "message": f"Model '{stats['model_name']}' loaded successfully",
                "embedding_dimension": stats["embedding_dimension"]
            }
        
        # Check FAISS index status
        if vector_manager.faiss_index is None:
            health_status["status"] = "unhealthy"
            health_status["checks"]["faiss_index"] = {
                "status": "failed",
                "message": "FAISS index not initialized"
            }
        else:
            health_status["checks"]["faiss_index"] = {
                "status": "healthy",
                "message": f"FAISS index initialized with {stats['index_size']} vectors",
                "index_type": stats["index_type"],
                "index_size": stats["index_size"]
            }
        
        # Check database connectivity
        if not kb_loader:
            health_status["status"] = "unhealthy"
            health_status["checks"]["database"] = {
                "status": "failed",
                "message": "KB data loader not initialized"
            }
        else:
            # Test database connection
            db_connection_ok = kb_loader.test_connection()
            if not db_connection_ok:
                health_status["status"] = "unhealthy"
                health_status["checks"]["database"] = {
                    "status": "failed",
                    "message": "Database connection test failed"
                }
            else:
                # Check database schema
                schema_ok = kb_loader.check_database_schema()
                if not schema_ok:
                    health_status["status"] = "degraded"
                    health_status["checks"]["database"] = {
                        "status": "warning",
                        "message": "Database schema validation failed"
                    }
                else:
                    try:
                        kb_count = kb_loader.get_kb_count()
                        health_status["checks"]["database"] = {
                            "status": "healthy",
                            "message": "Database connection and schema OK",
                            "kb_entries_count": kb_count
                        }
                    except Exception as e:
                        health_status["status"] = "degraded"
                        health_status["checks"]["database"] = {
                            "status": "warning",
                            "message": f"Database accessible but query failed: {str(e)}"
                        }
        
        # Add cache statistics
        health_status["cache_stats"] = stats.get("cache_stats", {})
        
        # Determine final status code
        if health_status["status"] == "unhealthy":
            raise HTTPException(status_code=503, detail=health_status)
        elif health_status["status"] == "degraded":
            # Return 200 but indicate degraded status
            return health_status
        else:
            return health_status
            
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        logging.error(f"Health check failed with unexpected error: {e}")
        error_response = {
            "status": "unhealthy",
            "service": "vector-service",
            "version": "1.0.0",
            "error": str(e),
            "message": "Health check failed with unexpected error"
        }
        raise HTTPException(status_code=503, detail=error_response)

@app.get("/cache/stats")
async def get_cache_stats():
    """Get cache statistics"""
    try:
        if not vector_manager:
            raise HTTPException(status_code=503, detail="Vector manager not initialized")
        
        return vector_manager.get_cache_info()
    except Exception as e:
        logging.error(f"Failed to get cache stats: {e}")
        raise HTTPException(status_code=500, detail="Failed to get cache statistics")

@app.post("/cache/cleanup")
async def cleanup_cache():
    """Clean up expired cache entries"""
    try:
        if not vector_manager:
            raise HTTPException(status_code=503, detail="Vector manager not initialized")
        
        expired_count = vector_manager.cleanup_cache()
        return {
            "success": True,
            "expired_entries_removed": expired_count,
            "message": f"Cleaned up {expired_count} expired cache entries"
        }
    except Exception as e:
        logging.error(f"Failed to cleanup cache: {e}")
        raise HTTPException(status_code=500, detail="Failed to cleanup cache")

@app.post("/cache/sync")
async def sync_cache():
    """Synchronize cache with database"""
    try:
        if not vector_manager or not kb_loader:
            raise HTTPException(status_code=503, detail="Services not initialized")
        
        sync_stats = vector_manager.sync_cache_with_database(kb_loader)
        return {
            "success": True,
            "sync_stats": sync_stats,
            "message": "Cache synchronization completed"
        }
    except Exception as e:
        logging.error(f"Failed to sync cache: {e}")
        raise HTTPException(status_code=500, detail="Failed to sync cache")

@app.delete("/cache/{kb_id}")
async def invalidate_cache_entry(kb_id: int):
    """Invalidate cache entry for specific KB ID"""
    try:
        if not vector_manager:
            raise HTTPException(status_code=503, detail="Vector manager not initialized")
        
        vector_manager.invalidate_cache_entry(kb_id)
        return {
            "success": True,
            "message": f"Cache entry for KB ID {kb_id} invalidated"
        }
    except Exception as e:
        logging.error(f"Failed to invalidate cache entry {kb_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to invalidate cache entry")



# Vector Management Endpoints

@app.post("/vectors/add", response_model=VectorResponse)
async def add_vector(request: VectorAddRequest):
    """
    Add new vector data to the FAISS index
    Generates embeddings for the provided text and stores in the vector index
    """
    try:
        if not vector_manager:
            raise HTTPException(
                status_code=503, 
                detail="Vector manager not initialized"
            )
        
        # Validate request data
        if not request.input_text.strip():
            raise HTTPException(
                status_code=400,
                detail="Input text cannot be empty"
            )
        
        if not request.answer.strip():
            raise HTTPException(
                status_code=400,
                detail="Answer cannot be empty"
            )
        
        if request.id <= 0:
            raise HTTPException(
                status_code=400,
                detail="KB ID must be a positive integer"
            )
        
        # Add vector to index
        vector_data = vector_manager.add_vector(
            kb_id=request.id,
            text=request.input_text,
            answer=request.answer
        )
        
        logging.info(f"Successfully added vector for KB ID {request.id}")
        
        return VectorResponse(
            success=True,
            message=f"Vector added successfully for KB ID {request.id}",
            vector_data=vector_data.tolist() if vector_data is not None else None
        )
        
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except VectorServiceError as e:
        logging.error(f"Vector service error adding vector for KB ID {request.id}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Vector operation failed: {e.message}"
        )
    except Exception as e:
        logging.error(f"Unexpected error adding vector for KB ID {request.id}: {e}")
        raise HTTPException(
            status_code=500,
            detail="Failed to add vector data"
        )

@app.put("/vectors/update", response_model=VectorResponse)
async def update_vector(request: VectorUpdateRequest):
    """
    Update existing vector data in the FAISS index
    Regenerates embeddings for the updated text content
    """
    try:
        if not vector_manager:
            raise HTTPException(
                status_code=503,
                detail="Vector manager not initialized"
            )
        
        # Validate request data
        if not request.input_text.strip():
            raise HTTPException(
                status_code=400,
                detail="Input text cannot be empty"
            )
        
        if not request.answer.strip():
            raise HTTPException(
                status_code=400,
                detail="Answer cannot be empty"
            )
        
        if request.id <= 0:
            raise HTTPException(
                status_code=400,
                detail="KB ID must be a positive integer"
            )
        
        # Update vector in index
        vector_data = vector_manager.update_vector(
            kb_id=request.id,
            text=request.input_text,
            answer=request.answer
        )
        
        logging.info(f"Successfully updated vector for KB ID {request.id}")
        
        return VectorResponse(
            success=True,
            message=f"Vector updated successfully for KB ID {request.id}",
            vector_data=vector_data.tolist() if vector_data is not None else None
        )
        
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except VectorServiceError as e:
        logging.error(f"Vector service error updating vector for KB ID {request.id}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Vector operation failed: {e.message}"
        )
    except Exception as e:
        logging.error(f"Unexpected error updating vector for KB ID {request.id}: {e}")
        raise HTTPException(
            status_code=500,
            detail="Failed to update vector data"
        )

@app.delete("/vectors/delete", response_model=VectorResponse)
async def delete_vector(request: VectorDeleteRequest):
    """
    Delete vector data from the FAISS index
    Removes the vector associated with the specified KB ID
    """
    try:
        if not vector_manager:
            raise HTTPException(
                status_code=503,
                detail="Vector manager not initialized"
            )
        
        # Validate request data
        if request.id <= 0:
            raise HTTPException(
                status_code=400,
                detail="KB ID must be a positive integer"
            )
        
        # Delete vector from index
        success = vector_manager.delete_vector(kb_id=request.id)
        
        if success:
            logging.info(f"Successfully deleted vector for KB ID {request.id}")
            return VectorResponse(
                success=True,
                message=f"Vector deleted successfully for KB ID {request.id}"
            )
        else:
            logging.warning(f"Vector for KB ID {request.id} not found for deletion")
            raise HTTPException(
                status_code=404,
                detail=f"Vector for KB ID {request.id} not found"
            )
        
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except VectorServiceError as e:
        logging.error(f"Vector service error deleting vector for KB ID {request.id}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Vector operation failed: {e.message}"
        )
    except Exception as e:
        logging.error(f"Unexpected error deleting vector for KB ID {request.id}: {e}")
        raise HTTPException(
            status_code=500,
            detail="Failed to delete vector data"
        )

@app.post("/vectors/search", response_model=SearchResponse)
async def search_similar_vectors(request: VectorSearchRequest):
    """
    Search for similar vectors using FAISS similarity search
    Returns the most similar KB entry if similarity score exceeds threshold
    """
    try:
        if not vector_manager:
            raise HTTPException(
                status_code=503,
                detail="Vector manager not initialized"
            )
        
        # Validate request data
        if not request.query.strip():
            raise HTTPException(
                status_code=400,
                detail="Search query cannot be empty"
            )
        
        # Perform similarity search
        result = vector_manager.search_similar(request.query)
        
        if result is None:
            # No match found or similarity below threshold
            logging.info(f"No similar content found for query: '{request.query[:50]}...'")
            return SearchResponse(
                success=True,
                match_found=False,
                message="No similar content found above similarity threshold"
            )
        
        # Match found
        logging.info(f"Found similar content for query: KB ID {result.kb_id}, score {result.similarity_score}")
        
        return SearchResponse(
            success=True,
            match_found=True,
            similarity_score=result.similarity_score,
            kb_id=result.kb_id,
            answer=result.answer,
            message=f"Found similar content with {result.confidence_level} confidence"
        )
        
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except VectorServiceError as e:
        logging.error(f"Vector service error during search: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Search operation failed: {e.message}"
        )
    except Exception as e:
        logging.error(f"Unexpected error during similarity search: {e}")
        raise HTTPException(
            status_code=500,
            detail="Failed to perform similarity search"
        )

@app.post("/vectors/embed")
async def generate_embedding(request: dict):
    """
    Generate embedding vector for given text
    Returns the embedding vector as a list of floats
    """
    try:
        if not vector_manager:
            raise HTTPException(
                status_code=503,
                detail="Vector service not initialized"
            )
        
        text = request.get("text", "")
        if not text or not text.strip():
            raise HTTPException(
                status_code=400,
                detail="Text is required for embedding generation"
            )
        
        # Generate embedding using the sentence transformer
        if not vector_manager.sentence_transformer:
            raise HTTPException(
                status_code=503,
                detail="SentenceTransformer model not loaded"
            )
        
        # Generate embedding
        embedding = vector_manager.sentence_transformer.encode([text], convert_to_numpy=True)
        
        # Normalize for cosine similarity if using IndexFlatIP
        if vector_manager.index_type == "IndexFlatIP":
            import faiss
            faiss.normalize_L2(embedding)
        
        # Convert to list for JSON serialization
        embedding_list = embedding[0].tolist()
        
        logging.info(f"Generated embedding with {len(embedding_list)} dimensions for text: {text[:50]}...")
        
        return {
            "success": True,
            "embedding": embedding_list,
            "dimension": len(embedding_list),
            "text_length": len(text)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Unexpected error during embedding generation: {e}")
        raise HTTPException(
            status_code=500,
            detail="Failed to generate embedding"
        )

if __name__ == "__main__":
    try:
        settings = get_settings()
        
        # Configure logging
        logging.basicConfig(
            level=getattr(logging, settings.log_level.upper()),
            format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
        )
        
        print(f"🚀 Starting Vector Service")
        print(f"� Hoste: {settings.host}")
        print(f"🔌 Port: {settings.port}")
        print(f"�t Log Level: {settings.log_level}")
        print(f"🗄️ Database: {settings.db_path}")
        print(f"🤖 Model: {settings.model_name}")
        print("-" * 50)
        
        # For debugging, use string import to avoid reload issues
        if settings.debug:
            print("🐛 Running in DEBUG mode with auto-reload")
            uvicorn.run(
                "app.main:app",
                host=settings.host,
                port=settings.port,
                reload=True,
                log_level=settings.log_level.lower()
            )
        else:
            print("🚀 Running in PRODUCTION mode")
            uvicorn.run(
                app,
                host=settings.host,
                port=settings.port,
                reload=False
            )
            
    except KeyboardInterrupt:
        print("\n🛑 Service stopped by user")
    except Exception as e:
        print(f"❌ Failed to start service: {e}")
        logging.exception("Service startup failed")
        import sys
        sys.exit(1)