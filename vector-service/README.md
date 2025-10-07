# Vector Service

Python-based vector embedding and similarity search service.

## Quick Start

```bash
cd vector-service
python -m app
```

## Configuration

Edit `.env` file:
```
DB_PATH=../data/test.db
MODEL_NAME=sentence-transformers/all-MiniLM-L6-v2
```

## API Endpoints

- `GET /health` - Health check
- `POST /vectors/add` - Add vector
- `POST /vectors/search` - Search similar vectors
- `POST /vectors/embed` - Generate embedding