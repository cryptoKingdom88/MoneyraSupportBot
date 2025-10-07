"""
Vector Manager for FAISS operations and SentenceTransformer integration
Handles vector embedding generation and similarity search
"""

import logging
import numpy as np
from typing import List, Optional, Dict, Any
import faiss
from sentence_transformers import SentenceTransformer

from app.models import KBEntry, VectorData, SimilarityResult, ModelLoadError, IndexError
from app.cache_manager import VectorCacheManager

logger = logging.getLogger(__name__)

class VectorManager:
    """Manages FAISS vector indices and embedding operations"""
    
    def __init__(self, model_name: str, similarity_threshold: float, index_type: str = "IndexFlatIP", 
                 max_cache_size: int = 1000):
        self.model_name = model_name
        self.similarity_threshold = similarity_threshold
        self.index_type = index_type
        
        # Initialize components
        self.sentence_transformer: Optional[SentenceTransformer] = None
        self.faiss_index: Optional[faiss.Index] = None
        self.cache_manager = VectorCacheManager(max_cache_size=max_cache_size)
        self.id_to_index_map: Dict[int, int] = {}  # Maps KB ID to FAISS index position
        self.index_to_id_map: Dict[int, int] = {}  # Maps FAISS index position to KB ID
        self.embedding_dimension: int = 384  # Default for all-MiniLM-L6-v2
        
        logger.info(f"VectorManager initialized with model: {model_name}, cache_size: {max_cache_size}")
    
    async def initialize_index(self, kb_entries: List[KBEntry]) -> None:
        """Initialize FAISS index and load existing KB data"""
        try:
            # Load SentenceTransformer model
            logger.info(f"Loading SentenceTransformer model: {self.model_name}")
            
            # Set cache directory if specified in environment
            import os
            if os.environ.get('SENTENCE_TRANSFORMERS_HOME'):
                cache_folder = os.environ.get('SENTENCE_TRANSFORMERS_HOME')
                logger.info(f"Using custom cache folder: {cache_folder}")
                self.sentence_transformer = SentenceTransformer(self.model_name, cache_folder=cache_folder)
            else:
                self.sentence_transformer = SentenceTransformer(self.model_name)
            
            # Get actual embedding dimension from model
            test_embedding = self.sentence_transformer.encode(["test"])
            self.embedding_dimension = test_embedding.shape[1]
            logger.info(f"Embedding dimension: {self.embedding_dimension}")
            
            # Initialize FAISS index
            self._create_faiss_index()
            
            # Process existing KB entries
            if kb_entries:
                logger.info(f"Processing {len(kb_entries)} existing KB entries")
                await self._build_index_from_entries(kb_entries)
            
            logger.info("Vector index initialization completed successfully")
            
        except Exception as e:
            logger.error(f"Failed to initialize vector index: {e}")
            raise ModelLoadError(f"Vector index initialization failed: {e}")
    
    def _create_faiss_index(self) -> None:
        """Create FAISS index based on configuration"""
        try:
            if self.index_type == "IndexFlatIP":
                # Inner product index (cosine similarity with normalized vectors)
                self.faiss_index = faiss.IndexFlatIP(self.embedding_dimension)
            elif self.index_type == "IndexFlatL2":
                # L2 distance index
                self.faiss_index = faiss.IndexFlatL2(self.embedding_dimension)
            else:
                # Default to inner product
                self.faiss_index = faiss.IndexFlatIP(self.embedding_dimension)
                logger.warning(f"Unknown index type {self.index_type}, using IndexFlatIP")
            
            logger.info(f"Created FAISS index: {self.index_type}")
            
        except Exception as e:
            raise IndexError(f"Failed to create FAISS index: {e}")
    
    async def _build_index_from_entries(self, kb_entries: List[KBEntry]) -> None:
        """Build FAISS index from existing KB entries"""
        try:
            embeddings_list = []
            valid_entries = []
            
            for entry in kb_entries:
                # Try to load embedding from context field first
                embedding = self._load_embedding_from_context(entry.context)
                
                if embedding is not None:
                    # Use stored embedding
                    embeddings_list.append(embedding)
                    valid_entries.append(entry)
                    logger.debug(f"Loaded stored embedding for KB ID {entry.id}")
                else:
                    # Generate new embedding if not stored
                    combined_text = entry.question
                    if combined_text.strip():
                        logger.info(f"Generating new embedding for KB ID {entry.id}")
                        new_embedding = self.sentence_transformer.encode([combined_text], convert_to_numpy=True)[0]
                        
                        # Normalize for cosine similarity
                        if self.index_type == "IndexFlatIP":
                            faiss.normalize_L2(new_embedding.reshape(1, -1))
                        
                        embeddings_list.append(new_embedding)
                        valid_entries.append(entry)
                
                # Cache the entry
                self.cache_manager.put_kb_entry(entry.id, entry)
            
            if not embeddings_list:
                logger.info("No valid embeddings found")
                return
            
            # Convert to numpy array
            embeddings = np.array(embeddings_list, dtype=np.float32)
            
            # Add to FAISS index
            self.faiss_index.add(embeddings)
            
            # Update mapping dictionaries
            for i, entry in enumerate(valid_entries):
                self.id_to_index_map[entry.id] = i
                self.index_to_id_map[i] = entry.id
            
            logger.info(f"Successfully built index with {len(valid_entries)} vectors ({len([e for e in kb_entries if self._load_embedding_from_context(e.context) is not None])} from stored embeddings)")
            
        except Exception as e:
            logger.error(f"Failed to build index from entries: {e}")
            raise IndexError(f"Index building failed: {e}")
    
    def _load_embedding_from_context(self, context: str) -> Optional[np.ndarray]:
        """Load embedding vector from context field (stored as JSON)"""
        try:
            if not context or not context.strip():
                return None
            
            # Try to parse as JSON array
            import json
            embedding_list = json.loads(context)
            
            if isinstance(embedding_list, list) and len(embedding_list) > 0:
                # Convert to numpy array
                embedding = np.array(embedding_list, dtype=np.float32)
                
                # Validate dimension
                if len(embedding) == self.embedding_dimension:
                    return embedding
                else:
                    logger.warning(f"Embedding dimension mismatch: expected {self.embedding_dimension}, got {len(embedding)}")
                    return None
            
            return None
            
        except (json.JSONDecodeError, ValueError, TypeError) as e:
            # Context is not a valid JSON embedding, return None to generate new one
            logger.debug(f"Context is not a valid embedding JSON: {e}")
            return None
        except Exception as e:
            logger.warning(f"Failed to load embedding from context: {e}")
            return None
    
    def add_vector(self, kb_id: int, text: str, answer: str) -> np.ndarray:
        """Add new vector to FAISS index"""
        try:
            if not self.sentence_transformer or not self.faiss_index:
                raise IndexError("Vector manager not properly initialized")
            
            # Check if vector already exists for this KB ID
            if kb_id in self.id_to_index_map:
                logger.warning(f"Vector for KB ID {kb_id} already exists, updating instead of adding")
                return self.update_vector(kb_id, text, answer)
            
            # Generate embedding
            embedding = self.sentence_transformer.encode([text], convert_to_numpy=True)
            
            # Normalize for cosine similarity
            if self.index_type == "IndexFlatIP":
                faiss.normalize_L2(embedding)
            
            # Add to index
            current_size = self.faiss_index.ntotal
            self.faiss_index.add(embedding.astype(np.float32))
            
            # Update mappings
            self.id_to_index_map[kb_id] = current_size
            self.index_to_id_map[current_size] = kb_id
            
            logger.info(f"Added vector to FAISS index: KB ID {kb_id} -> index position {current_size}")
            logger.info(f"Current index size: {self.faiss_index.ntotal}, mappings: {len(self.id_to_index_map)}")
            
            # Cache vector data
            vector_data = VectorData(kb_id, embedding[0], text, answer)
            self.cache_manager.put_vector_data(kb_id, vector_data)
            
            # Also cache KB entry for similarity search
            from datetime import datetime
            import json
            # Store embedding as JSON string in context for future use
            embedding_json = json.dumps(embedding[0].tolist())
            kb_entry = KBEntry(
                id=kb_id,
                category="",  # Will be updated when full KB entry is available
                question=text,
                context=embedding_json,  # Store embedding as JSON
                answer=answer,
                create_time=datetime.now(),
                update_time=datetime.now()
            )
            self.cache_manager.put_kb_entry(kb_id, kb_entry)
            
            logger.info(f"Added vector for KB ID {kb_id} and updated cache")
            logger.info(f"Added text: '{text[:50]}...'")
            logger.info(f"Added embedding first 5 values: {embedding[0][:5]}")
            return embedding[0]
            
        except Exception as e:
            logger.error(f"Failed to add vector for KB ID {kb_id}: {e}")
            raise IndexError(f"Vector addition failed: {e}")
    
    def update_vector(self, kb_id: int, text: str, answer: str) -> np.ndarray:
        """Update existing vector in FAISS index"""
        try:
            if kb_id not in self.id_to_index_map:
                # If vector doesn't exist, add it
                return self.add_vector(kb_id, text, answer)
            
            # Generate new embedding
            embedding = self.sentence_transformer.encode([text], convert_to_numpy=True)
            
            # Normalize for cosine similarity
            if self.index_type == "IndexFlatIP":
                faiss.normalize_L2(embedding)
            
            # Get the index position for this KB ID
            index_pos = self.id_to_index_map[kb_id]
            
            # Update the vector in FAISS index
            # For IndexFlat, we can reconstruct and update the specific vector
            if hasattr(self.faiss_index, 'reconstruct'):
                # Update the vector at the specific position
                self.faiss_index.reconstruct(index_pos)  # This validates the position exists
                
                # Create a new index with updated vector
                # Since FAISS IndexFlat doesn't support in-place updates, we need to rebuild
                logger.info(f"Rebuilding FAISS index to update vector for KB ID {kb_id}")
                
                # Get all current vectors
                all_vectors = []
                all_kb_ids = []
                
                for current_kb_id, current_index_pos in self.id_to_index_map.items():
                    if current_kb_id == kb_id:
                        # Use the new embedding for this KB ID
                        all_vectors.append(embedding[0])
                    else:
                        # Reconstruct existing vector
                        existing_vector = self.faiss_index.reconstruct(current_index_pos)
                        all_vectors.append(existing_vector)
                    all_kb_ids.append(current_kb_id)
                
                # Rebuild the index
                if all_vectors:
                    vectors_array = np.array(all_vectors).astype('float32')
                    
                    # Create new index
                    new_index = faiss.IndexFlatIP(self.embedding_dimension) if self.index_type == "IndexFlatIP" else faiss.IndexFlatL2(self.embedding_dimension)
                    new_index.add(vectors_array)
                    
                    # Replace the old index
                    self.faiss_index = new_index
                    
                    # Rebuild mappings
                    self.id_to_index_map.clear()
                    self.index_to_id_map.clear()
                    
                    for i, current_kb_id in enumerate(all_kb_ids):
                        self.id_to_index_map[current_kb_id] = i
                        self.index_to_id_map[i] = current_kb_id
                    
                    logger.info(f"Successfully rebuilt FAISS index with updated vector for KB ID {kb_id}")
            else:
                # Fallback: simple replacement (less efficient but works)
                logger.warning(f"Using fallback method for vector update of KB ID {kb_id}")
                
                # Remove and re-add (this will append to the end)
                self.delete_vector(kb_id)
                return self.add_vector(kb_id, text, answer)
            
            # Invalidate cache entry to force refresh
            self.cache_manager.invalidate_entry(kb_id)
            
            # Cache updated vector data
            vector_data = VectorData(kb_id, embedding[0], text, answer)
            self.cache_manager.put_vector_data(kb_id, vector_data)
            
            # Also update KB entry cache
            from datetime import datetime
            import json
            # Store embedding as JSON string in context for future use
            embedding_json = json.dumps(embedding[0].tolist())
            kb_entry = KBEntry(
                id=kb_id,
                category="",  # Will be updated when full KB entry is available
                question=text,
                context=embedding_json,  # Store embedding as JSON
                answer=answer,
                create_time=datetime.now(),
                update_time=datetime.now()
            )
            self.cache_manager.put_kb_entry(kb_id, kb_entry)
            
            # Mark as dirty for potential synchronization
            self.cache_manager.mark_vector_dirty(kb_id)
            
            logger.info(f"Updated vector for KB ID {kb_id} and refreshed cache")
            return embedding[0]
            
        except Exception as e:
            logger.error(f"Failed to update vector for KB ID {kb_id}: {e}")
            raise IndexError(f"Vector update failed: {e}")
    
    def delete_vector(self, kb_id: int) -> bool:
        """Delete vector from FAISS index"""
        try:
            if kb_id not in self.id_to_index_map:
                logger.warning(f"Vector for KB ID {kb_id} not found in index")
                return False
            
            # Get the index position for this KB ID
            index_pos = self.id_to_index_map[kb_id]
            
            # FAISS IndexFlat doesn't support direct deletion, so we rebuild the index
            logger.info(f"Rebuilding FAISS index to delete vector for KB ID {kb_id}")
            
            # Get all current vectors except the one to delete
            all_vectors = []
            all_kb_ids = []
            
            for current_kb_id, current_index_pos in self.id_to_index_map.items():
                if current_kb_id != kb_id:  # Skip the vector to delete
                    # Reconstruct existing vector
                    if hasattr(self.faiss_index, 'reconstruct'):
                        existing_vector = self.faiss_index.reconstruct(current_index_pos)
                        all_vectors.append(existing_vector)
                        all_kb_ids.append(current_kb_id)
            
            # Rebuild the index without the deleted vector
            if all_vectors:
                vectors_array = np.array(all_vectors).astype('float32')
                
                # Create new index
                new_index = faiss.IndexFlatIP(self.embedding_dimension) if self.index_type == "IndexFlatIP" else faiss.IndexFlatL2(self.embedding_dimension)
                new_index.add(vectors_array)
                
                # Replace the old index
                self.faiss_index = new_index
                
                # Rebuild mappings
                self.id_to_index_map.clear()
                self.index_to_id_map.clear()
                
                for i, current_kb_id in enumerate(all_kb_ids):
                    self.id_to_index_map[current_kb_id] = i
                    self.index_to_id_map[i] = current_kb_id
                
                logger.info(f"Successfully rebuilt FAISS index without vector for KB ID {kb_id}")
            else:
                # No vectors left, create empty index
                self.faiss_index = faiss.IndexFlatIP(self.embedding_dimension) if self.index_type == "IndexFlatIP" else faiss.IndexFlatL2(self.embedding_dimension)
                self.id_to_index_map.clear()
                self.index_to_id_map.clear()
                logger.info(f"Created empty FAISS index after deleting last vector (KB ID {kb_id})")
            
            # Remove from cache
            self.cache_manager.invalidate_entry(kb_id)
            
            logger.info(f"Successfully deleted vector for KB ID {kb_id} and updated index")
            return True
            
        except Exception as e:
            logger.error(f"Failed to delete vector for KB ID {kb_id}: {e}")
            raise IndexError(f"Vector deletion failed: {e}")
    
    def search_similar(self, query: str) -> Optional[SimilarityResult]:
        """Search for similar vectors using FAISS"""
        try:
            if not self.sentence_transformer or not self.faiss_index:
                raise IndexError("Vector manager not properly initialized")
            
            if self.faiss_index.ntotal == 0:
                logger.info("No vectors in index for search")
                return None
            
            # Generate query embedding
            query_embedding = self.sentence_transformer.encode([query], convert_to_numpy=True)
            
            # Normalize for cosine similarity
            if self.index_type == "IndexFlatIP":
                faiss.normalize_L2(query_embedding)
            
            logger.info(f"Query: '{query[:50]}...'")
            logger.info(f"Query embedding shape: {query_embedding.shape}")
            logger.info(f"Query embedding first 5 values: {query_embedding[0][:5]}")
            
            # Search for most similar vector - get top 5 to see all candidates
            k = min(5, self.faiss_index.ntotal)
            scores, indices = self.faiss_index.search(query_embedding.astype(np.float32), k=k)
            
            logger.info(f"FAISS search results (top {k}): scores={scores[0]}, indices={indices[0]}")
            logger.info(f"Current index mappings: {self.index_to_id_map}")
            logger.info(f"Total vectors in index: {self.faiss_index.ntotal}")
            
            if len(scores[0]) == 0:
                logger.info("No search results returned from FAISS")
                return None
            
            # Use the best match (first result)
            similarity_score = float(scores[0][0])
            best_index = int(indices[0][0])
            
            logger.info(f"Best match: index={best_index}, score={similarity_score}, threshold={self.similarity_threshold}")
            
            # Check similarity threshold
            if similarity_score < self.similarity_threshold:
                logger.info(f"Best similarity score {similarity_score} below threshold {self.similarity_threshold}")
                return None
            
            # Get KB ID from index mapping
            kb_id = self.index_to_id_map.get(best_index)
            if not kb_id:
                logger.error(f"No KB ID found for index {best_index}. Available mappings: {self.index_to_id_map}")
                return None
            
            logger.info(f"Found KB ID {kb_id} for index {best_index}")
            
            # Get KB entry from cache
            kb_entry = self.cache_manager.get_kb_entry(kb_id)
            if not kb_entry:
                logger.error(f"KB entry {kb_id} not found in cache - this should not happen after proper add/update")
                return None
            
            # Determine confidence level
            confidence_level = self._get_confidence_level(similarity_score)
            
            result = SimilarityResult(
                kb_id=kb_id,
                similarity_score=similarity_score,
                answer=kb_entry.answer,
                confidence_level=confidence_level
            )
            
            logger.info(f"Found similar content: KB ID {kb_id}, score {similarity_score}")
            return result
            
        except Exception as e:
            logger.error(f"Failed to search similar vectors: {e}")
            raise IndexError(f"Vector search failed: {e}")
    
    def _get_confidence_level(self, similarity_score: float) -> str:
        """Determine confidence level based on similarity score"""
        if similarity_score >= 0.9:
            return "high"
        elif similarity_score >= 0.8:
            return "medium"
        else:
            return "low"
    
    def get_index_size(self) -> int:
        """Get current index size"""
        return self.faiss_index.ntotal if self.faiss_index else 0
    
    def get_cache_size(self) -> int:
        """Get current cache size"""
        return self.cache_manager.get_cache_stats()["kb_cache_size"]
    
    def clear_cache(self) -> None:
        """Clear KB cache"""
        self.cache_manager.clear_all()
        logger.info("KB cache cleared")
    
    def get_stats(self) -> Dict[str, Any]:
        """Get vector manager statistics"""
        cache_stats = self.cache_manager.get_cache_stats()
        return {
            "index_size": self.get_index_size(),
            "cache_size": self.get_cache_size(),
            "embedding_dimension": self.embedding_dimension,
            "model_name": self.model_name,
            "similarity_threshold": self.similarity_threshold,
            "index_type": self.index_type,
            "cache_stats": cache_stats
        }
    
    def cleanup_cache(self) -> int:
        """Clean up expired cache entries"""
        return self.cache_manager.cleanup_expired_entries()
    
    def invalidate_cache_entry(self, kb_id: int) -> None:
        """Invalidate cache entry for a specific KB ID"""
        self.cache_manager.invalidate_entry(kb_id)
    
    def get_cache_info(self) -> Dict[str, Any]:
        """Get detailed cache information"""
        return {
            "stats": self.cache_manager.get_cache_stats(),
            "entries": self.cache_manager.get_cache_entries_info()
        }
    
    def sync_cache_with_database(self, kb_loader) -> Dict[str, int]:
        """Synchronize cache with database"""
        return self.cache_manager.sync_with_database(kb_loader, self)