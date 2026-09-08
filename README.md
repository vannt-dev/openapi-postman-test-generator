# Swagger/OpenAPI to Postman test generator

MVP chuyển Swagger 2.0 hoặc OpenAPI 3.x thành Postman Collection có sẵn test scripts và một Postman Environment.

## Chạy nhanh

```powershell
npm install
npm run build
npm run generate -- --spec .\fixtures\petstore.openapi.yaml
```

Kết quả mặc định nằm trong `generated/api.collection.json` và `generated/api.environment.json`.

```powershell
npm run generate -- --spec .\openapi.yaml `
  --out .\generated\api.collection.json `
  --env .\generated\test.environment.json `
  --base-url https://test-api.example.com `
  --response-time 2000
```

Import hai file kết quả vào Postman. Điền token/API key trong environment rồi chạy Collection Runner.

Nếu đã cài Newman, có thể chạy từ CI:

```powershell
npx newman run .\generated\api.collection.json `
  -e .\generated\api.environment.json `
  --reporters cli,junit `
  --reporter-junit-export .\generated\report.xml
```

## Những gì được sinh tự động

- Request cho mọi path và HTTP method.
- Query, path, header, JSON body và form body từ schema/example/default.
- Bearer, Basic Auth, OAuth2 token placeholder và API key.
- Assertions cho status code, response time và JSON Schema.
- Lưu các trường `id`/`*Id` từ response POST vào collection variables.

OpenAPI chỉ mô tả hợp đồng kỹ thuật. Các workflow nghiệp vụ phức tạp, dữ liệu seed, OTP, upload file thật và side effect nguy hiểm vẫn cần cấu hình riêng.
