# Faz 5: biçimlendirme, tablolar ve formüller

Status, 2026-10-26: F5-01–F5-07 implementation and local acceptance are complete. The remote native matrix on Node 22/24 remains open before release. The [implementation and verification plan](implementation-plan.md) records Phase 0–4 carryovers, confirmed merge/table/structured-formula decisions, concrete owners and ordered gates. The [implementation status](implementation-status.md) links the sanitized evidence and distinguishes direct model execution from exact recorded-call replay. Common requirements remain in the [main roadmap](../README.md).

## Hedef

Agent, veriyi kullanıma uygun görünümde sunabilsin ve istenen hesaplama ilişkilerini çalışma kitabına ekleyebilsin.

## Kapsam

| Kimlik | İhtiyaç                                                                                                                                |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| F5-01  | Sayı, para, yüzde, tarih ve saat görünümünü alttaki değerden ayrı belirlemek.                                                          |
| F5-02  | Yazı tipi, vurgu, renk, kenarlık, hizalama ve metin kaydırma gibi temel görünüm işlemleri.                                             |
| F5-03  | Satır yüksekliği, kolon genişliği, sabit başlıklar, görünürlük ve temel baskı düzeni.                                                  |
| F5-04  | Gerekli durumda birleştirilmiş hücreler oluşturmak/düzenlemek; veri kaybı davranışını belirlemek.                                      |
| F5-05  | Sıradan veri aralığından ayrı olarak Excel tablosu oluşturmak/düzenlemek; başlık, veri, toplam ve filtre davranışını tanımlamak.       |
| F5-06  | Formül eklemek, değiştirmek ve bir alana uygulamak; göreli, mutlak ve sayfalar arası başvuruları ele almak.                            |
| F5-07  | Formül, kaydedilmiş sonuç, hesaplanmamış sonuç ve hesaplama hatasını ayrı ayrı ifade etmek; formülü yazmayı hesaplama olarak sunmamak. |

## Kodlama iş paketleri

1. Değer türü ile görünümün ayrı doğrulanacağı örnekleri ve destek kapsamını belirlemek.
2. Temel hücre biçimleri ve sayfa düzeni işlemlerini eklemek.
3. Excel tablosu oluşturma ve veri aralığı değişimlerini, Faz 3–4 işlemleriyle birlikte ele almak.
4. Formül yazma, kopyalama ve referans davranışlarını tamamlamak.
5. Formül yazıldıktan sonraki hesaplama durumunun doğru bildirilmesini ve kaynak korunarak yeni sürüm üretilmesini doğrulamak. Sunucuda hesaplama motorunu bu iş paketine dahil etmemek.

## Bağımlılıklar ve sınırlar

- Tarihi doğru değer olarak yazmak için Faz 5'i beklemek gerekmez; ilk tarih desteğinin veri anlamı Faz 1'de belirlenir.
- Var olan formülü veya tabloyu korumak, Faz 3'teki düzenlemelerin gereksinimidir.
- Kullanıcı kararıyla bu faz formül yazmaya odaklanır; Excel kurulmadan sunucuda hesaplama ayrı [Faz 6](../phase-6/README.md) kapsamıdır.
- Yeni formül yazabilmek, bütün Excel işlevlerini hesaplayabilmek anlamına gelmez.
- = ile başlayan literal metin ve gerçek formül ayrı niyetlerle yazılabilmelidir.
- Mevcut okuyucunun önbellekteki sonucu okuyabilmesi, son yazılan formülün hesaplandığını kanıtlamaz.
- Taşınan/kopyalanan formülde hangi başvuruların değişeceği ayrı bir davranıştır.
- Grafik, özet tablo ve koşullu biçimlendirme gibi ileri özellikler [Faz 7](../phase-7/README.md) kapsamındadır.

## Kabul senaryoları

- Bir gider raporu tarih ve para görünümüyle hazırlanır; alttaki değerler değişmez.
- Başlık, kolon genişliği ve sabitlenmiş alanlarla okunabilir çıktı elde edilir.
- Bir Excel tablosuna kayıt eklenir; aralık, başlık ve toplam davranışı beklenen duruma gelir.
- Basit toplam ve sayfalar arası formül örnekleri oluşturulur; göreli/mutlak başvurular kontrol edilir.
- Kullanıcı dosyayı aldığında formüllerin hesaplanmış olup olmadığı doğru bildirilir.
- Biçim ve hesaplama iddiaları yalnızca dosyayı yeniden okumaya dayanmadan, gerekli bağımsız içerik/görünüm kontrolleriyle değerlendirilir.

## Açık kararlar

A-09 scope is recorded in the [implementation plan](implementation-plan.md): basic formats/layout, safe merge with explicitly requested loss, the full table lifecycle and formula authoring including structured table/column references. New dynamic arrays and external-workbook links are excluded. Formula result-state reporting is part of Phase 5; server-side calculation remains Phase 6 under K1-06/A-12. Exact schemas, supported syntax and measured limits are finalized in P5-01.
