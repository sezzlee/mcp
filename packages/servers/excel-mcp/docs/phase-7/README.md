# Faz 7: uzman seviye Excel iş akışları

Status, 2026-10-27: all eight approved families are implemented and accepted in the order F7-06 → F7-03 → F7-04 → F7-05 → F7-01 → F7-02 → F7-07 → F7-08. The [implementation and verification plan](implementation-plan.md) records the support profiles and earlier-phase obligations. Local corpus, model, application, schema and resource checks plus full native/installed-package CI passed for [PR #73](https://github.com/sezzlee/mcp/pull/73). See the [implementation status](implementation-status.md) and [acceptance record](acceptance-record.json). The immutable-version decision and [shared roadmap](../README.md) remain applicable.

## Hedef

Gerçek uzman senaryolarında gereken ileri özellikleri seçerek desteklemek; dosyanın sadece açılmasını değil, amaçlanan raporlama ve etkileşim davranışını da doğrulamak.

Bu faz bütün Excel özelliklerinin destekleneceği vaadi değildir. Aşağıdaki aileler bütün resmi görmek için aday olarak yazılmıştır.

## İhtiyaç aileleri

| Kimlik | Aday ihtiyaç                       | Ayrı ayrı değerlendirilecek yetenekler                                                               |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| F7-01  | Grafikler                          | Oluşturma, başlık/seri düzenleme, veri aralığı güncelleme, mevcut grafiği koruma.                    |
| F7-02  | Özet tablolar                      | Oluşturma, kaynak değiştirme, gruplama ve ölçüler, yenileme, kaydedilmiş sonuçları koruma.           |
| F7-03  | Veri doğrulama                     | Liste ve giriş kuralları oluşturma/düzenleme; yeni kayıtlara uygulama.                               |
| F7-04  | Koşullu biçimlendirme              | Kural oluşturma, değiştirme, öncelik ve uygulama alanını yönetme.                                    |
| F7-05  | Görseller ve açıklayıcı içerik     | Resim, bağlantı, not/açıklama ve konumlarının seçilmiş kapsamda yönetimi.                            |
| F7-06  | Adlandırılmış alanlar ve şablonlar | Yeniden kullanılabilir şablonu doldurma; adlandırılmış hedefler ve bağlı alanları koruma.            |
| F7-07  | Koruma ve özel dosya özellikleri   | Sayfa/kitap koruması ve makro içeren biçimlerde koruma veya düzenleme beklentisini ayrı belirleme.   |
| F7-08  | Tekrarlanan raporlama              | Aynı şablonu yeni dönem verisiyle güncelleme; tekrar çalıştırma ve kaynak değişikliklerini ele alma. |

Makro içeriğini koruma, makroyu düzenleme ve makro çalıştırma farklı ihtiyaçlardır. Bunlardan biri kabul edildiğinde diğerleri desteklenmiş sayılmaz.

## Kodlama iş paketleri

1. Her ihtiyaç ailesi için okuma, oluşturma, düzenleme, koruma, hesaplama/yenileme desteğini ayrı ayrı belirlemek.
2. Gerçek kullanım değeri ve önceki faz bağımlılıklarına göre bu faz içindeki geliştirme sırasını seçmek.
3. Seçilen özelliğin temel işlemlerini ve ilgili veri değişikliklerine tepkisini tamamlamak.
4. Şablon, çoklu sayfa ve tekrar eden iş örneklerini bir arada doğrulamak.
5. Destek ve koruma kapsamını belgelerle birlikte güncellemek.

The approved implementation order and concrete work packages are recorded in the [plan](implementation-plan.md#ordered-work-packages).

## Bağımlılıklar ve sınırlar

- Sunucuda formül hesaplama ayrı Faz 6'dır. Grafik oluşturma, mevcut hesaplanmış sonucu kullanma ve bir özet tabloyu yenileme birbirine denk hesaplama yetenekleri değildir.
- Değişiklikler kaynağı koruyup yeni çıktı sürümünde sunulur.

- Grafik ve özet tablo kaynakları, Faz 3–4'teki veri ve yapı değişikliklerinden etkilenebilir.
- Formül sonucu, grafik/özet tablo önbelleği ve yenilenmiş çıktı aynı şey değildir.
- Desteklenen özellikleri yeniden oluşturabilmek ile bilinmeyen özellikleri kayıpsız koruyabilmek ayrı kabiliyetlerdir.
- Büyük veri, ilerleme, hata ve yeniden deneme ihtiyaçları önceki fazlarda başlar; burada daha karmaşık senaryolara genişler.
- Uzun süren iş veya eşzamanlı düzenleme için beklenen sonuçlar seçilmiş senaryolara göre kesinleştirilir.

## Kabul senaryoları

- Seçilmiş bir rapor şablonu yeni dönem kayıtlarıyla doldurulur; gerekli formüller, görseller ve ilgili rapor alanları korunur.
- Destekleniyorsa kaynak aralığı değişen grafik veya özet tablo, kararlaştırılmış güncelleme/yenileme sonucunu verir.
- Veri doğrulama ve koşullu biçimlendirme kuralları, yeni kayıtlarda ve yapısal değişikliklerden sonra beklenen alanlarda geçerlidir.
- Aynı dönem işi yeniden çalıştırıldığında istenmeyen çift kayıt veya tutarsız sonuç oluşmaz.
- Kaydetme, yeniden açma ve gerekli hesaplama/yenileme sonrasında seçilmiş uzman senaryosunun davranışı bağımsız olarak doğrulanır.
- Desteklenmeyen ileri özellikler açıkça belirlenir; yalnızca dosyanın açılması başarı kanıtı sayılmaz.

## Açık kararlar

A-10 priority and family selection were approved on 2026-10-27: all eight families, in the order recorded above. The plan defines bounded `.xlsx` support profiles; the [capability matrix and acceptance status](implementation-status.md) separate reading, authoring, preservation and refresh. Macro preservation, editing and execution are separate capabilities, never implied by family inclusion.
