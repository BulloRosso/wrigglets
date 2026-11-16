# Ontology compiler (Liquid Enterprise, ADR-0041): LinkML -> ontology IR. Pinned Python and LinkML.
#   docker build -f infra/docker/ontology-compiler.Dockerfile -t coworking/ontology-compiler:local .
#   docker run --rm -v "$PWD/ontology/sofa:/src:ro" coworking/ontology-compiler:local compile /src -o -
#   docker run --rm -p 127.0.0.1:7720:7720 coworking/ontology-compiler:local serve      (HTTP, used by the editor)
# The unit tests run during the build, so a broken compiler never becomes an image.
FROM openpolicyagent/opa:1.22.0-static@sha256:906bfc9904b2693733e7959d71773dd073e6c135cf06f26d955abe94603e82b3 AS opa
FROM python:3.12.12-slim-bookworm
# pinned OPA for POST /check-rego (validating policies in config proposals, ADR-0046)
COPY --from=opa /opa /usr/local/bin/opa
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY tools/ontology-compiler/requirements.txt ./
RUN pip install -r requirements.txt
COPY tools/ontology-compiler/ontology_compiler ./ontology_compiler
COPY tools/ontology-compiler/tests ./tests
COPY ontology/sofa ./tests/fixture
RUN python -m unittest discover -s tests && rm -rf tests/__pycache__
RUN useradd --uid 10001 --no-create-home compiler
USER 10001
EXPOSE 7720
ENTRYPOINT ["python", "-m", "ontology_compiler"]
CMD ["serve"]
