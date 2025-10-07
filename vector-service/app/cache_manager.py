"""
Cache Manager for Vector Service
Handles in-memory caching for KB entries and vector data with synchronization
"""

import logging
import time
from typing import Dict, Optional, List, Any, Set
from threading import Lock
from datetime import datetime, timedelta

from app.models import KBEntry, VectorData

logger = logging.getLogger(__name__)

class CacheEntry:
    """Represents a cached entry with metadata"""
    
    def __init__(self, data: Any, ttl_seconds: Optional[int] = None):
        self.data = data
        self.created_at = time.time()
        self.last_accessed = time.time()
        self.access_count = 1
        self.expires_at = time.time() + ttl_seconds if ttl_seconds else None
    
    def is_expired(self) -> bool:
        """Check if cache entry has expired"""
        if self.expires_at is None:
            return False
        return time.time() > self.expires_at
    
    def touch(self) -> None:
        """Update last accessed time and increment access count"""
        self.last_accessed = time.time()
        self.access_count += 1

class VectorCacheManager:
    """Manages in-memory caching for KB entries and vector data"""
    
    def __init__(self, max_cache_size: int = 1000, default_ttl: Optional[int] = None):
        self.max_cache_size = max_cache_size
        self.default_ttl = default_ttl
        
        # Cache storage
        self.kb_cache: Dict[int, CacheEntry] = {}
        self.vector_cache: Dict[int, CacheEntry] = {}
        
        # Cache metadata
        self.cache_hits = 0
        self.cache_misses = 0
        self.cache_evictions = 0
        
        # Thread safety
        self._lock = Lock()
        
        # Dirty tracking for synchronization
        self.dirty_kb_entries: Set[int] = set()
        self.dirty_vector_entries: Set[int] = set()
        
        logger.info(f"VectorCacheManager initialized with max_size={max_cache_size}, ttl={default_ttl}")
    
    def get_kb_entry(self, kb_id: int) -> Optional[KBEntry]:
        """Get KB entry from cache"""
        with self._lock:
            cache_entry = self.kb_cache.get(kb_id)
            
            if cache_entry is None:
                self.cache_misses += 1
                logger.debug(f"Cache miss for KB entry {kb_id}")
                return None
            
            if cache_entry.is_expired():
                self._remove_kb_entry(kb_id)
                self.cache_misses += 1
                logger.debug(f"Cache expired for KB entry {kb_id}")
                return None
            
            cache_entry.touch()
            self.cache_hits += 1
            logger.debug(f"Cache hit for KB entry {kb_id}")
            return cache_entry.data
    
    def put_kb_entry(self, kb_id: int, kb_entry: KBEntry, ttl_seconds: Optional[int] = None) -> None:
        """Put KB entry into cache"""
        with self._lock:
            # Use default TTL if not specified
            ttl = ttl_seconds if ttl_seconds is not None else self.default_ttl
            
            # Check if we need to evict entries
            if len(self.kb_cache) >= self.max_cache_size and kb_id not in self.kb_cache:
                self._evict_lru_kb_entry()
            
            self.kb_cache[kb_id] = CacheEntry(kb_entry, ttl)
            logger.debug(f"Cached KB entry {kb_id}")
    
    def remove_kb_entry(self, kb_id: int) -> bool:
        """Remove KB entry from cache"""
        with self._lock:
            return self._remove_kb_entry(kb_id)
    
    def _remove_kb_entry(self, kb_id: int) -> bool:
        """Internal method to remove KB entry (assumes lock is held)"""
        if kb_id in self.kb_cache:
            del self.kb_cache[kb_id]
            self.dirty_kb_entries.discard(kb_id)
            logger.debug(f"Removed KB entry {kb_id} from cache")
            return True
        return False
    
    def get_vector_data(self, kb_id: int) -> Optional[VectorData]:
        """Get vector data from cache"""
        with self._lock:
            cache_entry = self.vector_cache.get(kb_id)
            
            if cache_entry is None:
                self.cache_misses += 1
                logger.debug(f"Cache miss for vector data {kb_id}")
                return None
            
            if cache_entry.is_expired():
                self._remove_vector_data(kb_id)
                self.cache_misses += 1
                logger.debug(f"Cache expired for vector data {kb_id}")
                return None
            
            cache_entry.touch()
            self.cache_hits += 1
            logger.debug(f"Cache hit for vector data {kb_id}")
            return cache_entry.data
    
    def put_vector_data(self, kb_id: int, vector_data: VectorData, ttl_seconds: Optional[int] = None) -> None:
        """Put vector data into cache"""
        with self._lock:
            # Use default TTL if not specified
            ttl = ttl_seconds if ttl_seconds is not None else self.default_ttl
            
            # Check if we need to evict entries
            if len(self.vector_cache) >= self.max_cache_size and kb_id not in self.vector_cache:
                self._evict_lru_vector_entry()
            
            self.vector_cache[kb_id] = CacheEntry(vector_data, ttl)
            logger.debug(f"Cached vector data {kb_id}")
    
    def remove_vector_data(self, kb_id: int) -> bool:
        """Remove vector data from cache"""
        with self._lock:
            return self._remove_vector_data(kb_id)
    
    def _remove_vector_data(self, kb_id: int) -> bool:
        """Internal method to remove vector data (assumes lock is held)"""
        if kb_id in self.vector_cache:
            del self.vector_cache[kb_id]
            self.dirty_vector_entries.discard(kb_id)
            logger.debug(f"Removed vector data {kb_id} from cache")
            return True
        return False
    
    def _evict_lru_kb_entry(self) -> None:
        """Evict least recently used KB entry"""
        if not self.kb_cache:
            return
        
        # Find LRU entry
        lru_id = min(self.kb_cache.keys(), 
                    key=lambda k: self.kb_cache[k].last_accessed)
        
        self._remove_kb_entry(lru_id)
        self.cache_evictions += 1
        logger.debug(f"Evicted LRU KB entry {lru_id}")
    
    def _evict_lru_vector_entry(self) -> None:
        """Evict least recently used vector entry"""
        if not self.vector_cache:
            return
        
        # Find LRU entry
        lru_id = min(self.vector_cache.keys(), 
                    key=lambda k: self.vector_cache[k].last_accessed)
        
        self._remove_vector_data(lru_id)
        self.cache_evictions += 1
        logger.debug(f"Evicted LRU vector data {lru_id}")
    
    def mark_kb_dirty(self, kb_id: int) -> None:
        """Mark KB entry as dirty (needs synchronization)"""
        with self._lock:
            self.dirty_kb_entries.add(kb_id)
            logger.debug(f"Marked KB entry {kb_id} as dirty")
    
    def mark_vector_dirty(self, kb_id: int) -> None:
        """Mark vector data as dirty (needs synchronization)"""
        with self._lock:
            self.dirty_vector_entries.add(kb_id)
            logger.debug(f"Marked vector data {kb_id} as dirty")
    
    def get_dirty_kb_entries(self) -> Set[int]:
        """Get set of dirty KB entries"""
        with self._lock:
            return self.dirty_kb_entries.copy()
    
    def get_dirty_vector_entries(self) -> Set[int]:
        """Get set of dirty vector entries"""
        with self._lock:
            return self.dirty_vector_entries.copy()
    
    def clear_dirty_kb_entry(self, kb_id: int) -> None:
        """Clear dirty flag for KB entry"""
        with self._lock:
            self.dirty_kb_entries.discard(kb_id)
            logger.debug(f"Cleared dirty flag for KB entry {kb_id}")
    
    def clear_dirty_vector_entry(self, kb_id: int) -> None:
        """Clear dirty flag for vector entry"""
        with self._lock:
            self.dirty_vector_entries.discard(kb_id)
            logger.debug(f"Cleared dirty flag for vector entry {kb_id}")
    
    def cleanup_expired_entries(self) -> int:
        """Remove expired entries from cache"""
        with self._lock:
            expired_count = 0
            
            # Clean up expired KB entries
            expired_kb_ids = [
                kb_id for kb_id, entry in self.kb_cache.items() 
                if entry.is_expired()
            ]
            for kb_id in expired_kb_ids:
                self._remove_kb_entry(kb_id)
                expired_count += 1
            
            # Clean up expired vector entries
            expired_vector_ids = [
                kb_id for kb_id, entry in self.vector_cache.items() 
                if entry.is_expired()
            ]
            for kb_id in expired_vector_ids:
                self._remove_vector_data(kb_id)
                expired_count += 1
            
            if expired_count > 0:
                logger.info(f"Cleaned up {expired_count} expired cache entries")
            
            return expired_count
    
    def invalidate_entry(self, kb_id: int) -> None:
        """Invalidate both KB and vector cache entries for a given ID"""
        with self._lock:
            removed_kb = self._remove_kb_entry(kb_id)
            removed_vector = self._remove_vector_data(kb_id)
            
            if removed_kb or removed_vector:
                logger.info(f"Invalidated cache entries for KB ID {kb_id}")
    
    def clear_all(self) -> None:
        """Clear all cache entries"""
        with self._lock:
            kb_count = len(self.kb_cache)
            vector_count = len(self.vector_cache)
            
            self.kb_cache.clear()
            self.vector_cache.clear()
            self.dirty_kb_entries.clear()
            self.dirty_vector_entries.clear()
            
            logger.info(f"Cleared all cache entries: {kb_count} KB entries, {vector_count} vector entries")
    
    def get_cache_stats(self) -> Dict[str, Any]:
        """Get cache statistics"""
        with self._lock:
            total_requests = self.cache_hits + self.cache_misses
            hit_rate = (self.cache_hits / total_requests * 100) if total_requests > 0 else 0
            
            return {
                "kb_cache_size": len(self.kb_cache),
                "vector_cache_size": len(self.vector_cache),
                "max_cache_size": self.max_cache_size,
                "cache_hits": self.cache_hits,
                "cache_misses": self.cache_misses,
                "cache_evictions": self.cache_evictions,
                "hit_rate_percent": round(hit_rate, 2),
                "dirty_kb_entries": len(self.dirty_kb_entries),
                "dirty_vector_entries": len(self.dirty_vector_entries),
                "default_ttl": self.default_ttl
            }
    
    def get_cache_entries_info(self) -> Dict[str, List[Dict[str, Any]]]:
        """Get detailed information about cache entries"""
        with self._lock:
            kb_entries_info = []
            for kb_id, entry in self.kb_cache.items():
                kb_entries_info.append({
                    "kb_id": kb_id,
                    "created_at": datetime.fromtimestamp(entry.created_at).isoformat(),
                    "last_accessed": datetime.fromtimestamp(entry.last_accessed).isoformat(),
                    "access_count": entry.access_count,
                    "expires_at": datetime.fromtimestamp(entry.expires_at).isoformat() if entry.expires_at else None,
                    "is_expired": entry.is_expired(),
                    "is_dirty": kb_id in self.dirty_kb_entries
                })
            
            vector_entries_info = []
            for kb_id, entry in self.vector_cache.items():
                vector_entries_info.append({
                    "kb_id": kb_id,
                    "created_at": datetime.fromtimestamp(entry.created_at).isoformat(),
                    "last_accessed": datetime.fromtimestamp(entry.last_accessed).isoformat(),
                    "access_count": entry.access_count,
                    "expires_at": datetime.fromtimestamp(entry.expires_at).isoformat() if entry.expires_at else None,
                    "is_expired": entry.is_expired(),
                    "is_dirty": kb_id in self.dirty_vector_entries
                })
            
            return {
                "kb_entries": kb_entries_info,
                "vector_entries": vector_entries_info
            }
    
    def sync_with_database(self, kb_loader, vector_manager) -> Dict[str, int]:
        """Synchronize dirty entries with database and vector index"""
        sync_stats = {
            "kb_synced": 0,
            "vector_synced": 0,
            "errors": 0
        }
        
        # Sync dirty KB entries
        dirty_kb_ids = self.get_dirty_kb_entries()
        for kb_id in dirty_kb_ids:
            try:
                # Reload KB entry from database
                fresh_entry = kb_loader.get_kb_entry(kb_id)
                if fresh_entry:
                    self.put_kb_entry(kb_id, fresh_entry)
                    self.clear_dirty_kb_entry(kb_id)
                    sync_stats["kb_synced"] += 1
                else:
                    # Entry was deleted, remove from cache
                    self.remove_kb_entry(kb_id)
                    self.clear_dirty_kb_entry(kb_id)
                    sync_stats["kb_synced"] += 1
            except Exception as e:
                logger.error(f"Failed to sync KB entry {kb_id}: {e}")
                sync_stats["errors"] += 1
        
        # Sync dirty vector entries
        dirty_vector_ids = self.get_dirty_vector_entries()
        for kb_id in dirty_vector_ids:
            try:
                # This would typically involve regenerating vectors
                # For now, just clear the dirty flag
                self.clear_dirty_vector_entry(kb_id)
                sync_stats["vector_synced"] += 1
            except Exception as e:
                logger.error(f"Failed to sync vector entry {kb_id}: {e}")
                sync_stats["errors"] += 1
        
        if sync_stats["kb_synced"] > 0 or sync_stats["vector_synced"] > 0:
            logger.info(f"Cache sync completed: {sync_stats}")
        
        return sync_stats