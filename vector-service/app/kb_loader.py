"""
KB Data Loader for SQLite integration
Handles loading existing KB data from the database
"""

import sqlite3
import logging
from typing import List, Optional
from datetime import datetime

from app.models import KBEntry, DatabaseError

logger = logging.getLogger(__name__)

class KBDataLoader:
    """Loads KB data from SQLite database"""
    
    def __init__(self, db_path: str):
        self.db_path = db_path
        logger.info(f"KBDataLoader initialized with database: {db_path}")
    
    def _get_connection(self) -> sqlite3.Connection:
        """Get database connection with proper configuration"""
        try:
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row  # Enable column access by name
            return conn
        except sqlite3.Error as e:
            logger.error(f"Failed to connect to database {self.db_path}: {e}")
            raise DatabaseError(f"Database connection failed: {e}")
    
    def load_all_kb_entries(self) -> List[KBEntry]:
        """Load all KB entries from the database"""
        try:
            with self._get_connection() as conn:
                cursor = conn.cursor()
                
                # Query all KB entries
                query = """
                    SELECT id, category, question, context, answer, create_time, update_time
                    FROM knowledge_base
                    ORDER BY id
                """
                
                cursor.execute(query)
                rows = cursor.fetchall()
                
                kb_entries = []
                for row in rows:
                    try:
                        entry = self._row_to_kb_entry(row)
                        kb_entries.append(entry)
                    except Exception as e:
                        logger.warning(f"Failed to process KB entry ID {row['id']}: {e}")
                        continue
                
                logger.info(f"Loaded {len(kb_entries)} KB entries from database")
                return kb_entries
                
        except sqlite3.Error as e:
            logger.error(f"Failed to load KB entries: {e}")
            raise DatabaseError(f"Failed to load KB entries: {e}")
        except Exception as e:
            logger.error(f"Unexpected error loading KB entries: {e}")
            raise DatabaseError(f"Unexpected error: {e}")
    
    def get_kb_entry(self, kb_id: int) -> Optional[KBEntry]:
        """Get a specific KB entry by ID"""
        try:
            with self._get_connection() as conn:
                cursor = conn.cursor()
                
                query = """
                    SELECT id, category, question, context, answer, create_time, update_time
                    FROM knowledge_base
                    WHERE id = ?
                """
                
                cursor.execute(query, (kb_id,))
                row = cursor.fetchone()
                
                if row:
                    entry = self._row_to_kb_entry(row)
                    logger.debug(f"Retrieved KB entry ID {kb_id}")
                    return entry
                else:
                    logger.debug(f"KB entry ID {kb_id} not found")
                    return None
                    
        except sqlite3.Error as e:
            logger.error(f"Failed to get KB entry {kb_id}: {e}")
            raise DatabaseError(f"Failed to get KB entry: {e}")
        except Exception as e:
            logger.error(f"Unexpected error getting KB entry {kb_id}: {e}")
            raise DatabaseError(f"Unexpected error: {e}")
    
    def _row_to_kb_entry(self, row: sqlite3.Row) -> KBEntry:
        """Convert database row to KBEntry object"""
        try:
            # Parse datetime strings
            create_time = None
            update_time = None
            
            if row['create_time']:
                try:
                    create_time = datetime.fromisoformat(row['create_time'].replace('Z', '+00:00'))
                except (ValueError, AttributeError):
                    # Try alternative parsing if needed
                    create_time = datetime.now()
            
            if row['update_time']:
                try:
                    update_time = datetime.fromisoformat(row['update_time'].replace('Z', '+00:00'))
                except (ValueError, AttributeError):
                    # Try alternative parsing if needed
                    update_time = datetime.now()
            
            return KBEntry(
                id=row['id'],
                category=row['category'] or '',
                question=row['question'] or '',
                context=row['context'] or '',
                answer=row['answer'] or '',
                create_time=create_time or datetime.now(),
                update_time=update_time or datetime.now()
            )
            
        except Exception as e:
            logger.error(f"Failed to convert row to KBEntry: {e}")
            raise DatabaseError(f"Row conversion failed: {e}")
    
    def check_database_schema(self) -> bool:
        """Check if the database has the expected schema"""
        try:
            with self._get_connection() as conn:
                cursor = conn.cursor()
                
                # Check if knowledge_base table exists
                cursor.execute("""
                    SELECT name FROM sqlite_master 
                    WHERE type='table' AND name='knowledge_base'
                """)
                
                if not cursor.fetchone():
                    logger.error("knowledge_base table not found in database")
                    return False
                
                # Check table structure
                cursor.execute("PRAGMA table_info(knowledge_base)")
                columns = cursor.fetchall()
                
                required_columns = {'id', 'category', 'question', 'context', 'answer'}
                existing_columns = {col[1] for col in columns}
                
                missing_columns = required_columns - existing_columns
                if missing_columns:
                    logger.error(f"Missing required columns: {missing_columns}")
                    return False
                
                logger.info("Database schema validation passed")
                return True
                
        except sqlite3.Error as e:
            logger.error(f"Database schema check failed: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error during schema check: {e}")
            return False
    
    def get_kb_count(self) -> int:
        """Get total count of KB entries"""
        try:
            with self._get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT COUNT(*) FROM knowledge_base")
                count = cursor.fetchone()[0]
                return count
                
        except sqlite3.Error as e:
            logger.error(f"Failed to get KB count: {e}")
            raise DatabaseError(f"Failed to get KB count: {e}")
    
    def get_kb_categories(self) -> List[str]:
        """Get list of unique categories"""
        try:
            with self._get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT DISTINCT category FROM knowledge_base WHERE category IS NOT NULL")
                categories = [row[0] for row in cursor.fetchall()]
                return categories
                
        except sqlite3.Error as e:
            logger.error(f"Failed to get KB categories: {e}")
            raise DatabaseError(f"Failed to get KB categories: {e}")
    
    def test_connection(self) -> bool:
        """Test database connection"""
        try:
            with self._get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT 1")
                cursor.fetchone()
                logger.info("Database connection test successful")
                return True
                
        except Exception as e:
            logger.error(f"Database connection test failed: {e}")
            return False